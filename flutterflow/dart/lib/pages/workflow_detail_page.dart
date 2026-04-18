// ============================================================
// workflow_detail_page.dart
// RealSyncDynamics Agent-OS — Workflow-Detail-Seite
//
// FlutterFlow-Hinweis:
//   - Route: '/workflows/:id'
//   - Übergabe via Navigator.pushNamed(..., arguments: workflowMap)
//   - Human-Approval-Dialog bei status 'pending_approval'
//   - Expandable AgentRun-Logs
// ============================================================

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../services/api_service.dart';
import '../widgets/status_chip.dart';

class WorkflowDetailPage extends StatefulWidget {
  final String workflowId;

  const WorkflowDetailPage({super.key, required this.workflowId});

  @override
  State<WorkflowDetailPage> createState() => _WorkflowDetailPageState();
}

class _WorkflowDetailPageState extends State<WorkflowDetailPage> {
  // ─── State ──────────────────────────────────────────────────
  bool _isLoading = true;
  bool _isActioning = false;
  Map<String, dynamic> _workflow = {};
  List<dynamic> _tasks = [];
  List<dynamic> _agentRuns = [];
  String _errorMessage = '';

  // ─── Brand Colors ────────────────────────────────────────────
  static const Color _brandTeal = Color(0xFF01696F);

  // ─── Lifecycle ───────────────────────────────────────────────
  @override
  void initState() {
    super.initState();
    _loadWorkflow();
  }

  // ─── Data Loading ────────────────────────────────────────────

  Future<void> _loadWorkflow() async {
    setState(() => _isLoading = true);
    try {
      final data = await ApiService.getWorkflow(widget.workflowId);
      if (mounted) {
        setState(() {
          _workflow = data;
          _tasks = data['tasks'] as List<dynamic>? ?? [];
          _agentRuns = data['agent_runs'] as List<dynamic>? ?? [];
          _isLoading = false;
        });

        // Zeige Human-Approval-Dialog wenn nötig
        if (data['status'] == 'pending_approval') {
          WidgetsBinding.instance
              .addPostFrameCallback((_) => _showApprovalDialog());
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _isLoading = false;
          _errorMessage = e.toString().replaceFirst('Exception: ', '');
        });
      }
    }
  }

  // ─── Actions ─────────────────────────────────────────────────

  Future<void> _executeWorkflow() async {
    await _performAction(
      action: () => ApiService.executeWorkflow(widget.workflowId),
      confirmMessage: 'Workflow jetzt ausführen?',
    );
  }

  Future<void> _pauseWorkflow() async {
    await _performAction(
      action: () => ApiService.pauseWorkflow(widget.workflowId),
      confirmMessage: 'Workflow pausieren?',
    );
  }

  Future<void> _resumeWorkflow() async {
    await _performAction(
      action: () => ApiService.resumeWorkflow(widget.workflowId),
      confirmMessage: 'Workflow fortsetzen?',
    );
  }

  Future<void> _performAction({
    required Future<Map<String, dynamic>> Function() action,
    required String confirmMessage,
  }) async {
    final confirmed = await _showConfirmDialog(confirmMessage);
    if (!confirmed) return;

    setState(() => _isActioning = true);
    try {
      await action();
      await _loadWorkflow();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: Colors.red.shade700,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isActioning = false);
    }
  }

  Future<bool> _showConfirmDialog(String message) async {
    return await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
            title: const Text('Bestätigung'),
            content: Text(message),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('Abbrechen'),
              ),
              ElevatedButton(
                onPressed: () => Navigator.pop(ctx, true),
                style: ElevatedButton.styleFrom(backgroundColor: _brandTeal),
                child: const Text(
                  'Bestätigen',
                  style: TextStyle(color: Colors.white),
                ),
              ),
            ],
          ),
        ) ??
        false;
  }

  void _showApprovalDialog() {
    final commentController = TextEditingController();
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Row(
          children: [
            Icon(Icons.pending_outlined, color: Colors.purple.shade700),
            const SizedBox(width: 8),
            const Text('Freigabe erforderlich'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Dieser Workflow benötigt deine manuelle Freigabe bevor er fortfahren kann.',
              style: TextStyle(color: Colors.grey.shade700),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: commentController,
              maxLines: 3,
              decoration: InputDecoration(
                hintText: 'Optionaler Kommentar...',
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
              ),
            ),
          ],
        ),
        actions: [
          TextButton.icon(
            onPressed: () async {
              Navigator.pop(ctx);
              setState(() => _isActioning = true);
              try {
                await ApiService.rejectWorkflow(
                    widget.workflowId, commentController.text);
                await _loadWorkflow();
              } catch (e) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(e.toString())),
                  );
                }
              } finally {
                if (mounted) setState(() => _isActioning = false);
              }
            },
            icon: const Icon(Icons.close, color: Colors.red),
            label: const Text('Ablehnen',
                style: TextStyle(color: Colors.red)),
          ),
          ElevatedButton.icon(
            onPressed: () async {
              Navigator.pop(ctx);
              setState(() => _isActioning = true);
              try {
                await ApiService.approveWorkflow(
                    widget.workflowId, commentController.text);
                await _loadWorkflow();
              } catch (e) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(e.toString())),
                  );
                }
              } finally {
                if (mounted) setState(() => _isActioning = false);
              }
            },
            icon: const Icon(Icons.check, color: Colors.white),
            label: const Text('Genehmigen',
                style: TextStyle(color: Colors.white)),
            style: ElevatedButton.styleFrom(backgroundColor: _brandTeal),
          ),
        ],
      ),
    );
  }

  // ─── Build ───────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }

    if (_errorMessage.isNotEmpty && _workflow.isEmpty) {
      return Scaffold(
        appBar: AppBar(
          title: const Text('Workflow'),
          backgroundColor: _brandTeal,
          foregroundColor: Colors.white,
        ),
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.error_outline, size: 64, color: Colors.red),
              const SizedBox(height: 16),
              Text(_errorMessage),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: _loadWorkflow,
                child: const Text('Erneut versuchen'),
              ),
            ],
          ),
        ),
      );
    }

    final String name =
        _workflow['name'] as String? ?? 'Unbenannter Workflow';
    final String status = _workflow['status'] as String? ?? 'draft';
    final String? riskLevel = _workflow['risk_level'] as String?;
    final String? goal = _workflow['goal'] as String?;
    final String? description = _workflow['description'] as String?;

    return Scaffold(
      backgroundColor: Colors.grey.shade50,
      body: RefreshIndicator(
        onRefresh: _loadWorkflow,
        color: _brandTeal,
        child: CustomScrollView(
          slivers: [
            // ── SliverAppBar ────────────────────────────────────
            SliverAppBar(
              expandedHeight: 160,
              pinned: true,
              backgroundColor: _brandTeal,
              foregroundColor: Colors.white,
              flexibleSpace: FlexibleSpaceBar(
                title: Text(
                  name,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                background: Container(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [
                        _brandTeal,
                        _brandTeal.withOpacity(0.7),
                      ],
                    ),
                  ),
                  child: Padding(
                    padding:
                        const EdgeInsets.fromLTRB(16, 80, 16, 48),
                    child: Row(
                      children: [
                        StatusChip(status: status),
                        if (riskLevel != null) ...[
                          const SizedBox(width: 8),
                          StatusChip(status: riskLevel),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),

            // ── Content ──────────────────────────────────────────
            SliverToBoxAdapter(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // ── Action-Buttons ────────────────────────────
                  _buildActionButtons(status),

                  // ── Info-Sektion ──────────────────────────────
                  if (goal != null || description != null)
                    _buildInfoSection(goal, description),

                  // ── Tasks ─────────────────────────────────────
                  if (_tasks.isNotEmpty) _buildTasksSection(),

                  // ── Agent Runs / Logs ─────────────────────────
                  if (_agentRuns.isNotEmpty) _buildAgentRunsSection(),

                  // ── Compliance-Button ─────────────────────────
                  if (_workflow['compliance_report_id'] != null)
                    _buildComplianceButton(),

                  const SizedBox(height: 32),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ─── Section Widgets ─────────────────────────────────────────

  Widget _buildActionButtons(String status) {
    return Container(
      padding: const EdgeInsets.all(16),
      color: Colors.white,
      child: Row(
        children: [
          // Execute-Button: nur wenn draft oder completed
          if (status == 'draft' || status == 'completed' || status == 'error')
            Expanded(
              child: ElevatedButton.icon(
                onPressed: _isActioning ? null : _executeWorkflow,
                icon: _isActioning
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.play_arrow),
                label: const Text('Ausführen'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF2E7D32),
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
              ),
            ),

          // Pause-Button: nur wenn aktiv/running
          if (status == 'active' || status == 'running') ...[
            Expanded(
              child: ElevatedButton.icon(
                onPressed: _isActioning ? null : _pauseWorkflow,
                icon: const Icon(Icons.pause),
                label: const Text('Pausieren'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFFE65100),
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
              ),
            ),
          ],

          // Resume-Button: nur wenn pausiert
          if (status == 'paused') ...[
            Expanded(
              child: ElevatedButton.icon(
                onPressed: _isActioning ? null : _resumeWorkflow,
                icon: const Icon(Icons.play_arrow),
                label: const Text('Fortsetzen'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: _brandTeal,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
              ),
            ),
          ],

          // Approval-Button: nur wenn pending_approval
          if (status == 'pending_approval') ...[
            Expanded(
              child: ElevatedButton.icon(
                onPressed: _showApprovalDialog,
                icon: const Icon(Icons.pending_actions),
                label: const Text('Freigabe'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.purple.shade700,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildInfoSection(String? goal, String? description) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Ziel',
            style: TextStyle(
              fontWeight: FontWeight.bold,
              fontSize: 15,
              color: Colors.black87,
            ),
          ),
          if (goal != null) ...[
            const SizedBox(height: 6),
            Text(goal, style: TextStyle(color: Colors.grey.shade700)),
          ],
          if (description != null) ...[
            const SizedBox(height: 12),
            const Text(
              'Beschreibung',
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 15,
                color: Colors.black87,
              ),
            ),
            const SizedBox(height: 6),
            Text(description,
                style: TextStyle(color: Colors.grey.shade700)),
          ],
        ],
      ),
    );
  }

  Widget _buildTasksSection() {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(
              'Tasks (${_tasks.length})',
              style: const TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 15,
                color: Colors.black87,
              ),
            ),
          ),
          const Divider(height: 1),
          ..._tasks.map((task) {
            final t = task as Map<String, dynamic>;
            return _buildTaskTile(t);
          }),
        ],
      ),
    );
  }

  Widget _buildTaskTile(Map<String, dynamic> task) {
    final String name = task['name'] as String? ?? 'Task';
    final String status = task['status'] as String? ?? 'pending';

    IconData taskIcon;
    Color taskColor;

    switch (status) {
      case 'completed':
        taskIcon = Icons.check_circle;
        taskColor = const Color(0xFF2E7D32);
        break;
      case 'running':
        taskIcon = Icons.autorenew;
        taskColor = const Color(0xFF1565C0);
        break;
      case 'error':
        taskIcon = Icons.error;
        taskColor = Colors.red;
        break;
      case 'skipped':
        taskIcon = Icons.skip_next;
        taskColor = Colors.grey;
        break;
      default:
        taskIcon = Icons.radio_button_unchecked;
        taskColor = Colors.grey.shade400;
    }

    return ListTile(
      leading: Icon(taskIcon, color: taskColor, size: 22),
      title: Text(name, style: const TextStyle(fontSize: 14)),
      subtitle: task['agent_type'] != null
          ? Text(
              task['agent_type'] as String,
              style: TextStyle(fontSize: 12, color: Colors.grey.shade500),
            )
          : null,
      trailing: StatusChip(status: status, size: StatusChipSize.small),
    );
  }

  Widget _buildAgentRunsSection() {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: ExpansionTile(
        title: Text(
          'Agent-Logs (${_agentRuns.length})',
          style: const TextStyle(
            fontWeight: FontWeight.bold,
            fontSize: 15,
            color: Colors.black87,
          ),
        ),
        iconColor: _brandTeal,
        collapsedIconColor: Colors.grey,
        children: _agentRuns.take(20).map((run) {
          final r = run as Map<String, dynamic>;
          return _buildLogEntry(r);
        }).toList(),
      ),
    );
  }

  Widget _buildLogEntry(Map<String, dynamic> run) {
    final String agentType =
        run['agent_type'] as String? ?? 'agent';
    final String status = run['status'] as String? ?? 'unknown';
    final String? output = run['output'] as String?;
    final String? startedAt = run['started_at'] as String?;

    String timeLabel = '';
    if (startedAt != null) {
      try {
        final dt = DateTime.parse(startedAt).toLocal();
        timeLabel = DateFormat('HH:mm:ss').format(dt);
      } catch (_) {}
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(color: Colors.grey.shade100),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                agentType.toUpperCase(),
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.bold,
                  color: Colors.grey.shade600,
                  letterSpacing: 0.5,
                ),
              ),
              const Spacer(),
              if (timeLabel.isNotEmpty)
                Text(
                  timeLabel,
                  style:
                      TextStyle(fontSize: 11, color: Colors.grey.shade400),
                ),
              const SizedBox(width: 8),
              StatusChip(status: status, size: StatusChipSize.small),
            ],
          ),
          if (output != null && output.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              output.length > 120
                  ? '${output.substring(0, 117)}...'
                  : output,
              style: TextStyle(
                fontSize: 12,
                color: Colors.grey.shade700,
                fontFamily: 'monospace',
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildComplianceButton() {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      child: OutlinedButton.icon(
        onPressed: () => Navigator.pushNamed(
          context,
          '/compliance/${_workflow['compliance_report_id']}',
        ),
        icon: const Icon(Icons.verified_outlined),
        label: const Text('Compliance-Report anzeigen'),
        style: OutlinedButton.styleFrom(
          foregroundColor: _brandTeal,
          side: const BorderSide(color: _brandTeal),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
          ),
          minimumSize: const Size(double.infinity, 48),
        ),
      ),
    );
  }
}
