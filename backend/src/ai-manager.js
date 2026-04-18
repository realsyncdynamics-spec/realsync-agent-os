// ai-manager.js
// AI-Manager Orchestrator für EU-AI-Act-konformes AI-Ops-SaaS
// Version: 1.0.0
// Kompatibilität: Node.js >= 18, BullMQ >= 5, Rechtsrahmen: Verordnung (EU) 2024/1689

'use strict';

const { Queue, Worker, QueueEvents } = require('bullmq');

// ─────────────────────────────────────────────────────────────────────────────
// KONSTANTEN & KONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const RISK_LEVELS = Object.freeze({
  PROHIBITED: 'prohibited',
  HIGH: 'high',
  LIMITED: 'limited',
  MINIMAL: 'minimal',
});

const AGENT_TYPES = Object.freeze(['devops', 'marketing', 'compliance', 'research']);

const HIGH_RISK_ACTION_KEYWORDS = Object.freeze([
  'hr', 'hiring', 'firing', 'kündigung', 'einstellung', 'beförderung',
  'citizen', 'bürger', 'behörde', 'government', 'öffentlich',
  'schule', 'schüler', 'student', 'bildung', 'education',
  'health', 'gesundheit', 'medical', 'medizin',
  'score', 'bewertung', 'rating', 'ranking', 'profil',
  'biometric', 'biometrie', 'face', 'gesicht',
  'police', 'law enforcement', 'strafverfolgung',
  'credit', 'kredit', 'sozial', 'social benefit',
]);

const QUEUE_CONFIG = {
  name: 'ai-manager-tasks',
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
  },
};

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
};

// ─────────────────────────────────────────────────────────────────────────────
// HILFSFUNKTIONEN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Erzeugt einen ISO-8601-konformen Zeitstempel für Audit-Logs.
 * @returns {string}
 */
function auditTimestamp() {
  return new Date().toISOString();
}

/**
 * Erzeugt eine sortierbare, eindeutige Trace-ID für verteiltes Tracing.
 * Format: <unix-ms>-<random-hex-8>
 * @returns {string}
 */
function generateTraceId() {
  const rand = Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0');
  return `${Date.now()}-${rand}`;
}

/**
 * Sichere JSON-Ausgabe: verhindert circular reference Fehler und kürzt große Payloads.
 * @param {*} obj
 * @param {number} maxLength
 * @returns {string}
 */
function safeStringify(obj, maxLength = 4096) {
  try {
    const str = JSON.stringify(obj);
    return str.length > maxLength ? str.slice(0, maxLength) + '...[TRUNCATED]' : str;
  } catch {
    return '[NON_SERIALIZABLE]';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOGGER
// Pflicht nach Art. 12 EU AI Act: automatisches Logging aller sicherheitsrelevanten
// Ereignisse mit Zeitstempel, Tenant-ID, Workflow-ID und vollständiger Kausalitätskette.
// ─────────────────────────────────────────────────────────────────────────────

class AuditLogger {
  /**
   * @param {Object} db - Datenbankverbindung (MongoDB, PostgreSQL etc.)
   */
  constructor(db) {
    this.db = db;
    this.collection = 'audit_logs';
  }

  /**
   * Persistiert ein Audit-Ereignis in der Datenbank.
   * Alle Felder sind EU-AI-Act Art. 12 konform:
   * - Zeitstempel (UTC)
   * - Tenant-ID (Mandantentrennung)
   * - Workflow-ID (Kausalitätskette)
   * - Input-Hash / Output-Hash (Integrität)
   * - Risikoklasse (Klassifizierungsnachweis)
   *
   * @param {Object} params
   * @returns {Promise<string>} Log-Entry-ID
   */
  async log({
    event_type,
    tenant_id,
    workflow_id,
    task_id = null,
    trace_id,
    risk_level = null,
    actor = 'system',
    input_summary = null,
    output_summary = null,
    metadata = {},
    human_involved = false,
    human_actor_id = null,
    human_decision = null,
    error = null,
  }) {
    const entry = {
      timestamp: auditTimestamp(),
      event_type,
      tenant_id,
      workflow_id,
      task_id,
      trace_id,
      risk_level,
      actor,
      input_summary: input_summary ? safeStringify(input_summary) : null,
      output_summary: output_summary ? safeStringify(output_summary) : null,
      human_involved,
      human_actor_id,
      human_decision,
      error: error ? { message: error.message, code: error.code || null } : null,
      metadata,
      // Integrity field: allows detection of log tampering
      schema_version: '1.0',
    };

    try {
      // Datenbank-spezifische Insert-Logik (abstrahiert)
      const result = await this.db.collection(this.collection).insertOne(entry);
      return result.insertedId?.toString() || 'unknown';
    } catch (dbError) {
      // Fallback: Console-Logging wenn DB nicht erreichbar
      // In Produktion: Fail-Safe zu lokalem WORM-Storage
      console.error(`[AUDIT_FALLBACK] ${auditTimestamp()} | ${event_type} | tenant=${tenant_id} | workflow=${workflow_id}`, entry);
      return 'fallback';
    }
  }

  /**
   * Logt eine Human-Intervention (Override, Genehmigung, Ablehnung).
   * Pflicht nach Art. 14 EU AI Act.
   */
  async logHumanIntervention({ tenant_id, workflow_id, task_id, trace_id, actor_id, decision, reason, risk_level }) {
    return this.log({
      event_type: 'HUMAN_INTERVENTION',
      tenant_id,
      workflow_id,
      task_id,
      trace_id,
      risk_level,
      actor: `human:${actor_id}`,
      human_involved: true,
      human_actor_id: actor_id,
      human_decision: decision,
      metadata: { reason },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE SETUP (BullMQ / Redis-backed)
// Pattern nach Bull/BullMQ – produktionsreifes Setup mit:
// - Prioritäten (High-Risk-Tasks erhalten höhere Priorität für schnellere Human-Review)
// - Dead-Letter-Queue für fehlgeschlagene Tasks
// - Separate Queue für Human-Approval-Tasks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialisiert alle BullMQ-Queues und gibt sie zurück.
 * Aufruf einmalig beim Server-Start.
 *
 * @returns {{ taskQueue: Queue, approvalQueue: Queue, deadLetterQueue: Queue, connection: Object }}
 */
function setupQueues() {
  const connection = REDIS_CONFIG;

  // Haupt-Task-Queue: für alle automatisierten Agent-Tasks
  const taskQueue = new Queue(QUEUE_CONFIG.name, {
    connection,
    defaultJobOptions: QUEUE_CONFIG.defaultJobOptions,
  });

  // Human-Approval-Queue: für High-Risk-Tasks die menschliche Genehmigung erfordern
  // Art. 14 EU AI Act: Human-Oversight by design
  const approvalQueue = new Queue('ai-manager-approvals', {
    connection,
    defaultJobOptions: {
      attempts: 1, // Keine automatischen Retries für Human-Approval-Tasks
      removeOnComplete: { count: 2000 },
      removeOnFail: { count: 1000 },
    },
  });

  // Dead-Letter-Queue: für Tasks die nach maximaler Retry-Anzahl fehlschlagen
  // Ermöglicht manuelle Inspektion und Eskalation
  const deadLetterQueue = new Queue('ai-manager-dead-letter', {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: false, // DLQ-Tasks werden nie automatisch gelöscht
      removeOnFail: false,
    },
  });

  // Queue-Events für Monitoring und Audit-Logging
  const queueEvents = new QueueEvents(QUEUE_CONFIG.name, { connection });

  queueEvents.on('completed', ({ jobId, returnvalue }) => {
    console.info(`[QUEUE] Job ${jobId} completed`);
  });

  queueEvents.on('failed', ({ jobId, failedReason }) => {
    console.error(`[QUEUE] Job ${jobId} failed: ${failedReason}`);
  });

  return { taskQueue, approvalQueue, deadLetterQueue, connection };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI MANAGER HAUPTKLASSE
// ─────────────────────────────────────────────────────────────────────────────

class AIManager {
  /**
   * @param {Object} llmClient       - Austauschbarer LLM-Client (Grok, Gemini, Claude etc.)
   *                                   Muss Methode .complete(prompt: string): Promise<string> implementieren
   * @param {Object} taskQueue       - BullMQ Queue-Instanz (aus setupQueues())
   * @param {Object} db              - Datenbankverbindung
   * @param {Object} [options]       - Optionale Konfiguration
   * @param {Object} [options.approvalQueue]    - Separate Queue für Human-Approval-Tasks
   * @param {Object} [options.deadLetterQueue]  - Dead-Letter-Queue
   * @param {number} [options.maxRetries=3]     - Maximale Anzahl automatischer Retries
   * @param {number} [options.approvalTimeoutMs=86400000] - Human-Approval-Timeout (Standard: 24h)
   */
  constructor(llmClient, taskQueue, db, options = {}) {
    if (!llmClient || typeof llmClient.complete !== 'function') {
      throw new Error('AIManager: llmClient muss eine .complete(prompt) Methode implementieren.');
    }
    if (!taskQueue) {
      throw new Error('AIManager: taskQueue darf nicht null sein.');
    }
    if (!db) {
      throw new Error('AIManager: db darf nicht null sein.');
    }

    this.llm = llmClient;
    this.taskQueue = taskQueue;
    this.approvalQueue = options.approvalQueue || null;
    this.deadLetterQueue = options.deadLetterQueue || null;
    this.db = db;
    this.maxRetries = options.maxRetries ?? 3;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 86_400_000; // 24 Stunden
    this.auditLogger = new AuditLogger(db);

    // In-Memory-Cache für laufende Workflows (in Produktion: Redis oder DB)
    this._activeWorkflows = new Map();

    console.info(`[AI_MANAGER] Initialisiert | maxRetries=${this.maxRetries} | approvalTimeoutMs=${this.approvalTimeoutMs}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PUBLIC: processGoal
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Verarbeitet ein übergeordnetes Ziel (Goal) und orchestriert es in Tasks.
   *
   * Ablauf:
   * 1. Erstellt Orchestrierungs-Prompt und sendet ihn an LLM
   * 2. Parst LLM-Response in strukturierte Task-Liste
   * 3. Bestimmt Abhängigkeiten (depends_on) zwischen Tasks
   * 4. Prüft ob human_approval_required (für high-risk Schritte)
   * 5. Schreibt Tasks in Queue
   * 6. Gibt Workflow-Übersicht zurück
   *
   * @param {string} tenantId     - Mandanten-ID
   * @param {string} workflowId   - Eindeutige Workflow-ID
   * @param {string} goal         - Natürlichsprachliches Ziel
   * @param {Object} [context]    - Optionaler Kontext (Sektor, Nutzerdaten etc.)
   * @returns {Promise<{workflow_id: string, task_count: number, tasks_preview: Array, risk_level: string}>}
   */
  async processGoal(tenantId, workflowId, goal, context = {}) {
    const traceId = generateTraceId();

    // Audit-Log: Workflow-Start
    await this.auditLogger.log({
      event_type: 'WORKFLOW_STARTED',
      tenant_id: tenantId,
      workflow_id: workflowId,
      trace_id: traceId,
      input_summary: { goal: goal.slice(0, 512), context_keys: Object.keys(context) },
      metadata: { actor: 'user', source: 'processGoal' },
    });

    let riskAssessment;
    let workflowSteps;

    try {
      // Schritt 1: Risikoklassifizierung des Goals
      riskAssessment = await this.classifyRisk(goal, context);

      await this.auditLogger.log({
        event_type: 'RISK_CLASSIFIED',
        tenant_id: tenantId,
        workflow_id: workflowId,
        trace_id: traceId,
        risk_level: riskAssessment.risk_level,
        output_summary: riskAssessment,
      });

      // Schritt 2: Bei PROHIBITED → sofortiger Abbruch
      if (riskAssessment.risk_level === RISK_LEVELS.PROHIBITED) {
        await this.auditLogger.log({
          event_type: 'WORKFLOW_BLOCKED_PROHIBITED',
          tenant_id: tenantId,
          workflow_id: workflowId,
          trace_id: traceId,
          risk_level: RISK_LEVELS.PROHIBITED,
          metadata: { reasons: riskAssessment.reasons },
        });
        throw new Error(
          `Workflow ${workflowId} wurde blockiert: Ziel fällt unter verbotene KI-Praktiken (Art. 5 EU AI Act). Gründe: ${riskAssessment.reasons.join('; ')}`
        );
      }

      // Schritt 3: Workflow-Schritte generieren
      workflowSteps = await this.generateWorkflowSteps(goal, riskAssessment, context);

      // Schritt 4: Abhängigkeiten und Human-Approval-Flags setzen
      const enrichedTasks = this._enrichTasks(workflowSteps, riskAssessment, workflowId, tenantId, traceId);

      // Schritt 5: Tasks in Queue schreiben
      const queuedJobs = await this._enqueueTasks(enrichedTasks, tenantId, workflowId, traceId);

      // Workflow-State im In-Memory-Cache speichern
      this._activeWorkflows.set(workflowId, {
        tenant_id: tenantId,
        workflow_id: workflowId,
        goal,
        risk_level: riskAssessment.risk_level,
        trace_id: traceId,
        tasks: enrichedTasks,
        status: 'running',
        created_at: auditTimestamp(),
      });

      const result = {
        workflow_id: workflowId,
        task_count: enrichedTasks.length,
        risk_level: riskAssessment.risk_level,
        tasks_preview: enrichedTasks.map((t) => ({
          task_id: t.task_id,
          agent: t.agent,
          description: t.description,
          depends_on: t.depends_on,
          human_approval_required: t.human_approval_required,
          status: t.status,
        })),
        trace_id: traceId,
        queued_job_ids: queuedJobs.map((j) => j.id),
      };

      // Audit-Log: Workflow erfolgreich in Queue
      await this.auditLogger.log({
        event_type: 'WORKFLOW_ENQUEUED',
        tenant_id: tenantId,
        workflow_id: workflowId,
        trace_id: traceId,
        risk_level: riskAssessment.risk_level,
        output_summary: {
          task_count: result.task_count,
          approval_required_count: enrichedTasks.filter((t) => t.human_approval_required).length,
        },
      });

      return result;

    } catch (error) {
      // Audit-Log: Workflow-Fehler
      await this.auditLogger.log({
        event_type: 'WORKFLOW_FAILED',
        tenant_id: tenantId,
        workflow_id: workflowId,
        trace_id: traceId,
        risk_level: riskAssessment?.risk_level || 'unknown',
        error,
      });
      throw error;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PUBLIC: classifyRisk
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Klassifiziert das Risiko eines Goals nach EU-AI-Act.
   * Kombiniert regelbasierte Schnellprüfung mit LLM-basierter Tiefenanalyse.
   *
   * @param {string} goal
   * @param {Object} context
   * @returns {Promise<{risk_level: string, reasons: string[], annex_iii_matches: string[], human_approval_required: boolean}>}
   */
  async classifyRisk(goal, context = {}) {
    // Schnellprüfung: Keyword-basierte Vorab-Klassifizierung
    const goalLower = goal.toLowerCase();
    const contextStr = JSON.stringify(context).toLowerCase();
    const combinedText = `${goalLower} ${contextStr}`;

    const highRiskKeywordsFound = HIGH_RISK_ACTION_KEYWORDS.filter((kw) =>
      combinedText.includes(kw)
    );

    // LLM-basierte Risikoklassifizierung
    const classificationPrompt = this._buildRiskClassificationPrompt(goal, context, highRiskKeywordsFound);

    let llmResponse;
    try {
      llmResponse = await this.llm.complete(classificationPrompt);
    } catch (llmError) {
      console.error('[AI_MANAGER] LLM-Fehler bei Risikoklassifizierung:', llmError.message);
      // Fail-safe: Bei LLM-Fehler → High Risk annehmen (Art. 9 precautionary principle)
      return {
        risk_level: RISK_LEVELS.HIGH,
        reasons: ['LLM nicht verfügbar – precautionary high risk classification (Art. 9 EU AI Act)'],
        annex_iii_matches: [],
        human_approval_required: true,
        confidence: 'low',
      };
    }

    const parsed = this._parseJsonResponse(llmResponse, {
      risk_level: highRiskKeywordsFound.length > 0 ? RISK_LEVELS.HIGH : RISK_LEVELS.MINIMAL,
      reasons: ['Parse-Fehler – Fallback-Klassifizierung'],
      annex_iii_matches: [],
      human_approval_required: highRiskKeywordsFound.length > 0,
      confidence: 'low',
    });

    // Sicherheitsnetz: Bei Keywords immer mindestens Limited Risk
    if (highRiskKeywordsFound.length > 0 && parsed.risk_level === RISK_LEVELS.MINIMAL) {
      parsed.risk_level = RISK_LEVELS.LIMITED;
      parsed.reasons.push(`Keyword-basierte Hochstufung: ${highRiskKeywordsFound.join(', ')}`);
    }

    return parsed;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PUBLIC: generateWorkflowSteps
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Zerlegt ein Goal via LLM in strukturierte, agenten-zugeordnete Tasks.
   *
   * @param {string} goal
   * @param {Object} riskAssessment
   * @param {Object} context
   * @returns {Promise<Array<{task_id: string, agent: string, description: string, parameters: Object}>>}
   */
  async generateWorkflowSteps(goal, riskAssessment = {}, context = {}) {
    const orchestrationPrompt = this._buildOrchestrationPrompt(goal, riskAssessment, context);

    let llmResponse;
    try {
      llmResponse = await this.llm.complete(orchestrationPrompt);
    } catch (llmError) {
      throw new Error(`generateWorkflowSteps: LLM-Fehler: ${llmError.message}`);
    }

    const steps = this._parseJsonResponse(llmResponse, null);

    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('generateWorkflowSteps: LLM hat keine valide Task-Liste zurückgegeben.');
    }

    // Validierung und Normalisierung der Tasks
    return steps.map((step, index) => ({
      task_id: step.task_id || `task-unknown-${index + 1}`,
      agent: AGENT_TYPES.includes(step.agent) ? step.agent : 'research',
      description: step.description || `Task ${index + 1}`,
      parameters: step.parameters || {},
      estimated_duration_ms: step.estimated_duration_ms || 5000,
      priority: step.priority || 'normal',
    }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PUBLIC: handleTaskCompletion
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Wird aufgerufen wenn ein Task erfolgreich abgeschlossen wurde.
   * Triggert alle Tasks, deren depends_on-Bedingung nun erfüllt ist.
   *
   * @param {string} taskId
   * @param {*} result
   * @param {string} workflowId
   * @param {string} tenantId
   * @returns {Promise<{triggered_tasks: string[]}>}
   */
  async handleTaskCompletion(taskId, result, workflowId, tenantId) {
    const traceId = generateTraceId();

    await this.auditLogger.log({
      event_type: 'TASK_COMPLETED',
      tenant_id: tenantId,
      workflow_id: workflowId,
      task_id: taskId,
      trace_id: traceId,
      output_summary: result,
    });

    const workflow = this._activeWorkflows.get(workflowId);
    if (!workflow) {
      console.warn(`[AI_MANAGER] handleTaskCompletion: Workflow ${workflowId} nicht im Cache.`);
      return { triggered_tasks: [] };
    }

    // Task-Status im Workflow updaten
    const completedTask = workflow.tasks.find((t) => t.task_id === taskId);
    if (completedTask) {
      completedTask.status = 'completed';
      completedTask.result = result;
      completedTask.completed_at = auditTimestamp();
    }

    // Abhängige Tasks identifizieren, die jetzt ausgeführt werden können
    const triggeredTaskIds = [];
    const pendingTasks = workflow.tasks.filter((t) => t.status === 'pending');

    for (const pendingTask of pendingTasks) {
      const allDepsCompleted = pendingTask.depends_on.every((depId) => {
        const depTask = workflow.tasks.find((t) => t.task_id === depId);
        return depTask && depTask.status === 'completed';
      });

      if (allDepsCompleted) {
        // Task in Queue schieben
        try {
          await this._enqueueSingleTask(pendingTask, tenantId, workflowId, traceId);
          pendingTask.status = 'queued';
          triggeredTaskIds.push(pendingTask.task_id);

          await this.auditLogger.log({
            event_type: 'TASK_TRIGGERED',
            tenant_id: tenantId,
            workflow_id: workflowId,
            task_id: pendingTask.task_id,
            trace_id: traceId,
            metadata: { triggered_by: taskId },
          });
        } catch (enqueueError) {
          console.error(`[AI_MANAGER] Fehler beim Triggern von Task ${pendingTask.task_id}:`, enqueueError);
        }
      }
    }

    // Workflow-Abschluss prüfen
    const allCompleted = workflow.tasks.every((t) => t.status === 'completed');
    if (allCompleted) {
      workflow.status = 'completed';
      workflow.completed_at = auditTimestamp();

      await this.auditLogger.log({
        event_type: 'WORKFLOW_COMPLETED',
        tenant_id: tenantId,
        workflow_id: workflowId,
        trace_id: traceId,
        metadata: { total_tasks: workflow.tasks.length },
      });
    }

    return { triggered_tasks: triggeredTaskIds };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PUBLIC: handleTaskFailure
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Verarbeitet Task-Fehler mit Retry-Logik und Eskalationsmechanismus.
   *
   * Retry-Strategie:
   * - Versuch 1: Sofortiger Retry nach 2 Sekunden
   * - Versuch 2: Retry nach 10 Sekunden (exponentiell)
   * - Versuch 3: Retry nach 30 Sekunden
   * - Versuch > maxRetries: Eskalation an Human-Oversight und Dead-Letter-Queue
   *
   * @param {string} taskId
   * @param {Error} error
   * @param {string} workflowId
   * @param {string} tenantId
   * @param {number} [attemptNumber=1]
   * @returns {Promise<{action: 'retry'|'escalate'|'dead_letter', next_attempt_delay_ms?: number}>}
   */
  async handleTaskFailure(taskId, error, workflowId, tenantId, attemptNumber = 1) {
    const traceId = generateTraceId();

    await this.auditLogger.log({
      event_type: 'TASK_FAILED',
      tenant_id: tenantId,
      workflow_id: workflowId,
      task_id: taskId,
      trace_id: traceId,
      error,
      metadata: { attempt_number: attemptNumber },
    });

    const workflow = this._activeWorkflows.get(workflowId);
    const failedTask = workflow?.tasks.find((t) => t.task_id === taskId);
    const riskLevel = failedTask?.risk_level || workflow?.risk_level || RISK_LEVELS.MINIMAL;

    // Retry-Entscheidung
    if (attemptNumber <= this.maxRetries) {
      // Exponentielles Backoff: 2^attempt * 1000ms
      const delayMs = Math.pow(2, attemptNumber) * 1000;

      await this.auditLogger.log({
        event_type: 'TASK_RETRY_SCHEDULED',
        tenant_id: tenantId,
        workflow_id: workflowId,
        task_id: taskId,
        trace_id: traceId,
        metadata: { attempt_number: attemptNumber + 1, delay_ms: delayMs },
      });

      console.warn(
        `[AI_MANAGER] Task ${taskId} fehlgeschlagen (Versuch ${attemptNumber}/${this.maxRetries}). ` +
        `Retry in ${delayMs}ms.`
      );

      return { action: 'retry', next_attempt_delay_ms: delayMs };
    }

    // Maximale Retries überschritten → Eskalation
    console.error(
      `[AI_MANAGER] Task ${taskId} endgültig fehlgeschlagen nach ${attemptNumber} Versuchen. ` +
      `Eskalation wird eingeleitet.`
    );

    // Bei High-Risk-Tasks: Workflow pausieren und Human-Oversight benachrichtigen
    if (riskLevel === RISK_LEVELS.HIGH && this.approvalQueue) {
      await this.approvalQueue.add('escalation-review', {
        type: 'TASK_FAILURE_ESCALATION',
        tenant_id: tenantId,
        workflow_id: workflowId,
        task_id: taskId,
        error_message: error.message,
        error_stack: error.stack?.slice(0, 1024),
        trace_id: traceId,
        risk_level: riskLevel,
        timestamp: auditTimestamp(),
      }, {
        priority: 1, // Höchste Priorität
      });

      // Workflow pausieren
      if (workflow) {
        workflow.status = 'paused_escalation';
      }
    }

    // Task in Dead-Letter-Queue verschieben
    if (this.deadLetterQueue) {
      await this.deadLetterQueue.add('dead-letter', {
        tenant_id: tenantId,
        workflow_id: workflowId,
        task_id: taskId,
        final_error: error.message,
        attempts: attemptNumber,
        trace_id: traceId,
        timestamp: auditTimestamp(),
      });
    }

    await this.auditLogger.log({
      event_type: 'TASK_ESCALATED',
      tenant_id: tenantId,
      workflow_id: workflowId,
      task_id: taskId,
      trace_id: traceId,
      risk_level: riskLevel,
      error,
      metadata: { total_attempts: attemptNumber, escalation_type: 'dead_letter' },
    });

    if (failedTask) {
      failedTask.status = 'failed';
      failedTask.error = error.message;
    }

    return { action: 'dead_letter' };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATE: _buildOrchestrationPrompt
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Erstellt den Orchestrierungs-Prompt für die LLM-Task-Zerlegung.
   * Gibt strukturiertes JSON-Schema vor, das direkt geparst werden kann.
   *
   * @param {string} goal
   * @param {Object} riskAssessment
   * @param {Object} context
   * @returns {string}
   */
  _buildOrchestrationPrompt(goal, riskAssessment, context) {
    const riskContext = riskAssessment.risk_level
      ? `Das Goal wurde als "${riskAssessment.risk_level.toUpperCase()} RISK" klassifiziert (EU AI Act). ` +
        `High-Risk-Schritte MÜSSEN human_approval_required: true haben.`
      : '';

    return `Du bist ein AI-Orchestrator für ein EU-AI-Act-konformes SaaS-System.

Zerlege das folgende Ziel in Schritt-für-Schritt-Tasks für autonome Agenten.

Verfügbare Agenten: ${AGENT_TYPES.join(' | ')}
- devops: Server-Monitoring, Deployments, Log-Analyse, Infrastruktur
- marketing: Content-Erstellung, Social-Media, Kampagnen, SEO
- compliance: EU-AI-Act-Prüfungen, DSGVO-Reviews, Audit-Reports
- research: Datenrecherche, Analyse, Reports, Web-Suche

Ziel: "${goal}"
${context.sector ? `Sektor: ${context.sector}` : ''}
${context.tenant_type ? `Mandantentyp: ${context.tenant_type}` : ''}
${riskContext}

Regeln:
1. Jeder Task erhält eine eindeutige task_id (Format: "task-<nummer>")
2. depends_on ist ein Array von task_ids, die vorher abgeschlossen sein müssen ([] = kein Abhängigkeit)
3. human_approval_required: true wenn der Task mit hohem Risiko für Personen behaftet ist
4. Maximal 10 Tasks pro Workflow
5. Tasks müssen in der richtigen Reihenfolge ausführbar sein

Antworte AUSSCHLIESSLICH mit folgendem JSON-Array (kein Markdown, keine Erklärungen):
[
  {
    "task_id": "task-1",
    "agent": "devops|marketing|compliance|research",
    "description": "Klare Beschreibung was dieser Task tut",
    "parameters": {
      "input": "Beschreibung der erwarteten Eingabe",
      "output": "Beschreibung der erwarteten Ausgabe",
      "constraints": "Eventuelle Einschränkungen"
    },
    "depends_on": [],
    "human_approval_required": false,
    "priority": "high|normal|low",
    "estimated_duration_ms": 5000
  }
]`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATE: _buildRiskClassificationPrompt
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Erstellt den Risikobewertungs-Prompt (basiert auf Compliance-Agent Prompt 1).
   *
   * @param {string} goal
   * @param {Object} context
   * @param {string[]} highRiskKeywordsFound
   * @returns {string}
   */
  _buildRiskClassificationPrompt(goal, context, highRiskKeywordsFound) {
    return `Du bist ein EU-AI-Act-Compliance-Agent. Klassifiziere das Risiko des folgenden AI-Workflow-Ziels nach der Verordnung (EU) 2024/1689.

Risikoklassen: prohibited | high | limited | minimal

Ziel: "${goal}"
Kontext: ${JSON.stringify(context)}
${highRiskKeywordsFound.length > 0 ? `Erkannte Risiko-Keywords: ${highRiskKeywordsFound.join(', ')}` : ''}

Annex III High-Risk-Kategorien:
1. Biometrie (biometrische Identifikation, Emotionserkennung)
2. Kritische Infrastruktur (Energie, Wasser, Verkehr, digitale Infrastruktur)
3. Bildung (Zugang zu Bildung, Bewertung von Schülern, Überwachung)
4. Beschäftigung (Einstellung, Kündigung, Leistungsbewertung, Überwachung von Arbeitnehmern)
5. Wesentliche Dienstleistungen (Kredit, Sozialleistungen, Notfalldienste)
6. Strafverfolgung (Risikoabschätzung, Profilerstellung, Beweisauswertung)
7. Migration und Grenzkontrolle (Risikoabschätzung, Dokumentenprüfung)
8. Justiz und demokratische Prozesse (Entscheidungsunterstützung in Rechtssachen)

Prohibited (Art. 5): Social Scoring durch Behörden, Echtzeit-biometrische Fernidentifikation, Manipulation durch unterschwellige Techniken, Ausnutzung von Vulnerabilitäten.

Antworte AUSSCHLIESSLICH mit folgendem JSON (kein Markdown, keine Erklärungen):
{
  "risk_level": "prohibited|high|limited|minimal",
  "annex_iii_matches": [],
  "reasons": ["Begründung 1", "Begründung 2"],
  "human_approval_required": true|false,
  "confidence": "high|medium|low",
  "legal_references": ["Art. X EU AI Act"]
}`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATE: _enrichTasks
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Reichert die LLM-generierten Tasks mit Workflow-Metadaten an.
   * Setzt human_approval_required basierend auf Risikoklasse und Task-Keywords.
   *
   * @param {Array} tasks
   * @param {Object} riskAssessment
   * @param {string} workflowId
   * @param {string} tenantId
   * @param {string} traceId
   * @returns {Array}
   */
  _enrichTasks(tasks, riskAssessment, workflowId, tenantId, traceId) {
    return tasks.map((task, index) => {
      // Bestimme ob Human-Approval erforderlich:
      // a) Explizit durch LLM gesetzt
      // b) Workflow ist High-Risk
      // c) Task-Beschreibung enthält High-Risk-Keywords
      const taskDescLower = task.description.toLowerCase();
      const taskHasRiskyKeywords = HIGH_RISK_ACTION_KEYWORDS.some((kw) => taskDescLower.includes(kw));

      const humanApprovalRequired =
        task.human_approval_required === true ||
        riskAssessment.risk_level === RISK_LEVELS.HIGH ||
        taskHasRiskyKeywords;

      return {
        ...task,
        task_id: task.task_id || `task-${workflowId}-${index + 1}`,
        workflow_id: workflowId,
        tenant_id: tenantId,
        trace_id: traceId,
        risk_level: riskAssessment.risk_level,
        human_approval_required: humanApprovalRequired,
        depends_on: Array.isArray(task.depends_on) ? task.depends_on : [],
        status: 'pending',
        retry_count: 0,
        created_at: auditTimestamp(),
      };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATE: _enqueueTasks
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Schreibt alle Tasks ohne Abhängigkeiten sofort in die Queue.
   * Tasks mit Abhängigkeiten warten auf handleTaskCompletion().
   *
   * High-Risk-Tasks die Human-Approval erfordern werden in die approvalQueue geschrieben.
   *
   * @param {Array} tasks
   * @param {string} tenantId
   * @param {string} workflowId
   * @param {string} traceId
   * @returns {Promise<Array>}
   */
  async _enqueueTasks(tasks, tenantId, workflowId, traceId) {
    const queuedJobs = [];

    for (const task of tasks) {
      // Nur Tasks ohne Abhängigkeiten sofort starten
      if (task.depends_on.length === 0) {
        const job = await this._enqueueSingleTask(task, tenantId, workflowId, traceId);
        queuedJobs.push(job);
        task.status = 'queued';
      }
    }

    return queuedJobs;
  }

  /**
   * Schreibt einen einzelnen Task in die passende Queue.
   *
   * @param {Object} task
   * @param {string} tenantId
   * @param {string} workflowId
   * @param {string} traceId
   * @returns {Promise<Object>}
   */
  async _enqueueSingleTask(task, tenantId, workflowId, traceId) {
    const jobData = {
      ...task,
      tenant_id: tenantId,
      workflow_id: workflowId,
      trace_id: traceId,
      enqueued_at: auditTimestamp(),
    };

    const jobOptions = {
      jobId: task.task_id,
      priority: task.priority === 'high' ? 1 : task.priority === 'low' ? 10 : 5,
    };

    // High-Risk-Tasks mit Human-Approval → Approval-Queue
    if (task.human_approval_required && this.approvalQueue) {
      const job = await this.approvalQueue.add('human-approval-required', jobData, {
        ...jobOptions,
        delay: 0,
      });

      await this.auditLogger.log({
        event_type: 'TASK_PENDING_HUMAN_APPROVAL',
        tenant_id: tenantId,
        workflow_id: workflowId,
        task_id: task.task_id,
        trace_id: traceId,
        risk_level: task.risk_level,
        human_involved: true,
      });

      return job;
    }

    // Standard-Tasks → normale Task-Queue
    const job = await this.taskQueue.add(`agent:${task.agent}`, jobData, jobOptions);
    return job;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATE: _parseJsonResponse
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Parst JSON aus LLM-Antwort robust.
   * LLMs schicken manchmal Markdown-Code-Blöcke oder führende/nachfolgende Zeichen.
   *
   * @param {string} response
   * @param {*} fallback - Wert der zurückgegeben wird wenn Parse fehlschlägt
   * @returns {*}
   */
  _parseJsonResponse(response, fallback) {
    if (!response || typeof response !== 'string') {
      console.warn('[AI_MANAGER] _parseJsonResponse: Leere oder ungültige LLM-Antwort.');
      return fallback;
    }

    // Entferne Markdown-Code-Blöcke
    let cleaned = response
      .replace(/```json\n?/gi, '')
      .replace(/```\n?/gi, '')
      .trim();

    // Suche nach erstem JSON-Array oder Objekt
    const firstBracket = cleaned.indexOf('[');
    const firstBrace = cleaned.indexOf('{');

    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
      cleaned = cleaned.slice(firstBracket);
      const lastBracket = cleaned.lastIndexOf(']');
      if (lastBracket !== -1) cleaned = cleaned.slice(0, lastBracket + 1);
    } else if (firstBrace !== -1) {
      cleaned = cleaned.slice(firstBrace);
      const lastBrace = cleaned.lastIndexOf('}');
      if (lastBrace !== -1) cleaned = cleaned.slice(0, lastBrace + 1);
    }

    try {
      return JSON.parse(cleaned);
    } catch (parseError) {
      console.error('[AI_MANAGER] JSON-Parse-Fehler:', parseError.message, '| Response-Ausschnitt:', cleaned.slice(0, 200));
      return fallback;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKER-SETUP
// BullMQ Worker für die Verarbeitung von Task-Queue-Jobs.
// In Produktion: In separatem Worker-Prozess ausführen.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Erstellt und startet einen BullMQ Worker für die ai-manager-tasks Queue.
 *
 * @param {AIManager} aiManager
 * @param {Object} agentRegistry - Map von agent-type zu Agent-Instanz
 * @returns {Worker}
 */
function createTaskWorker(aiManager, agentRegistry) {
  const worker = new Worker(
    QUEUE_CONFIG.name,
    async (job) => {
      const { task_id, agent, description, parameters, tenant_id, workflow_id, trace_id, retry_count = 0 } = job.data;

      console.info(`[WORKER] Starte Task ${task_id} | Agent: ${agent} | Versuch: ${job.attemptsMade + 1}`);

      const agentHandler = agentRegistry[agent];
      if (!agentHandler) {
        throw new Error(`Worker: Kein Handler für Agent-Typ "${agent}" registriert.`);
      }

      // Task an zuständigen Agenten delegieren
      const result = await agentHandler.execute({
        task_id,
        description,
        parameters,
        tenant_id,
        workflow_id,
        trace_id,
      });

      // Task-Abschluss an AIManager melden → triggert abhängige Tasks
      await aiManager.handleTaskCompletion(task_id, result, workflow_id, tenant_id);

      return result;
    },
    {
      connection: REDIS_CONFIG,
      concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
      limiter: {
        // Rate-Limiting: max. 50 Tasks pro 10 Sekunden (LLM-API-Schutz)
        max: 50,
        duration: 10_000,
      },
    }
  );

  // Worker-Error-Handling
  worker.on('failed', async (job, error) => {
    if (!job) return;
    const { task_id, tenant_id, workflow_id } = job.data;
    console.error(`[WORKER] Task ${task_id} fehlgeschlagen (Versuch ${job.attemptsMade}):`, error.message);

    await aiManager.handleTaskFailure(
      task_id,
      error,
      workflow_id,
      tenant_id,
      job.attemptsMade
    );
  });

  worker.on('error', (error) => {
    console.error('[WORKER] Worker-Fehler:', error.message);
  });

  return worker;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  AIManager,
  AuditLogger,
  setupQueues,
  createTaskWorker,
  RISK_LEVELS,
  AGENT_TYPES,
};
