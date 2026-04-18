# FlutterFlow Integration Guide — RealSyncDynamics Agent-OS

Schritt-für-Schritt Anleitung zur Integration des RealSyncDynamics Backends in eine FlutterFlow-App.

---

## Voraussetzungen

- FlutterFlow-Projekt (Blank App oder bestehendes Projekt)
- RealSyncDynamics Backend läuft unter einer erreichbaren URL (z.B. `https://api.realsyncdynamics.com`)
- FlutterFlow-Plan mit Custom API Calls (ab Free mit Einschränkungen, empfohlen: Pro+)

---

## Schritt 1: API Base URL konfigurieren

### 1.1 App State Variable erstellen

1. In FlutterFlow: **App State** → **Add Field**
2. Felder anlegen:

| Field Name       | Type   | Initial Value                          | Persist |
|------------------|--------|----------------------------------------|---------|
| `apiBaseUrl`     | String | `https://api.realsyncdynamics.com`    | true    |
| `authToken`      | String | `""`                                   | true    |
| `refreshToken`   | String | `""`                                   | true    |
| `currentUserId`  | String | `""`                                   | true    |
| `currentTenantId`| String | `""`                                   | true    |

### 1.2 Custom Action: setApiBaseUrl (für Entwicklung/Staging)

Navigiere zu **Custom Actions** → **Add Action** → Name: `setApiBaseUrl`

```dart
// Custom Action: setApiBaseUrl
// Ermöglicht das Umschalten zwischen Dev, Staging und Prod
Future<void> setApiBaseUrl(String environment) async {
  final Map<String, String> urls = {
    'dev': 'http://localhost:3000',
    'staging': 'https://staging-api.realsyncdynamics.com',
    'prod': 'https://api.realsyncdynamics.com',
  };
  FFAppState().apiBaseUrl = urls[environment] ?? urls['prod']!;
}
```

---

## Schritt 2: Auth Token in App State speichern

### 2.1 API Call: AuthLogin importieren (aus flutterflow_api_connector.json)

Navigiere zu **API Calls** → **Add API Call** und konfiguriere:

- **Name:** `AuthLogin`
- **Method:** POST
- **URL:** `[apiBaseUrl]/api/auth/login`
- **Body (JSON):**
  ```json
  {
    "email": "[email]",
    "password": "[password]"
  }
  ```

### 2.2 Login Action Flow (auf Login Button)

```
1. [Action] Call API: AuthLogin
   - Params: email = emailTextField.text, password = passwordTextField.text
2. [Condition] If API Response success (status 200)
   → [Action] Update App State:
       authToken = response.body.json['access_token']
       refreshToken = response.body.json['refresh_token']
       currentUserId = response.body.json['user']['id']
       currentTenantId = response.body.json['user']['tenant_id']
   → [Action] Navigate To: WorkflowListPage
3. [Else]
   → [Action] Show Snack Bar: response.body.json['detail'] ?? 'Login fehlgeschlagen'
```

### 2.3 Token Refresh (Custom Action)

Erstelle eine Custom Action `refreshAuthToken` die bei 401-Responses automatisch aufgerufen wird:

```dart
Future<bool> refreshAuthToken() async {
  if (FFAppState().refreshToken.isEmpty) return false;
  
  final response = await makeApiRequest(
    method: 'POST',
    url: '${FFAppState().apiBaseUrl}/api/auth/refresh',
    body: {'refresh_token': FFAppState().refreshToken},
  );
  
  if (response.statusCode == 200) {
    final data = jsonDecode(response.body);
    FFAppState().authToken = data['access_token'];
    FFAppState().refreshToken = data['refresh_token'];
    return true;
  }
  
  // Token abgelaufen → Logout
  FFAppState().authToken = '';
  FFAppState().refreshToken = '';
  return false;
}
```

---

## Schritt 3: API Calls importieren

### 3.1 Manueller Import aller API Calls

Navigiere zu **API Calls** und erstelle die folgenden Calls (aus `flutterflow_api_connector.json`):

Für jeden Call:
1. **Add API Call** klicken
2. Name, Method, URL eintragen
3. Header hinzufügen: `Authorization: Bearer [auth_token]`, `Content-Type: application/json`
4. Query-Parameter oder Body-Fields eintragen
5. **Test API Call** mit Testdaten
6. **Response Fields** aus dem Response-Beispiel mappen

### 3.2 Gemeinsamer Header Helper

Da alle authentifizierten Calls denselben Auth-Header benötigen, erstelle eine Custom Function:

```dart
// Custom Function: getAuthHeaders
Map<String, String> getAuthHeaders() {
  return {
    'Authorization': 'Bearer ${FFAppState().authToken}',
    'Content-Type': 'application/json',
  };
}
```

### 3.3 API Calls Übersicht

| Call Name              | Method | Pfad                                    |
|------------------------|--------|-----------------------------------------|
| AuthLogin              | POST   | /api/auth/login                         |
| AuthRegister           | POST   | /api/auth/register                      |
| AuthRefreshToken       | POST   | /api/auth/refresh                       |
| GetWorkflows           | GET    | /api/workflows                          |
| GetWorkflowById        | GET    | /api/workflows/[workflow_id]            |
| CreateWorkflow         | POST   | /api/workflows                          |
| UpdateWorkflow         | PUT    | /api/workflows/[workflow_id]            |
| DeleteWorkflow         | DELETE | /api/workflows/[workflow_id]            |
| ExecuteWorkflow        | POST   | /api/workflows/[workflow_id]/execute    |
| PauseWorkflow          | POST   | /api/workflows/[workflow_id]/pause      |
| ResumeWorkflow         | POST   | /api/workflows/[workflow_id]/resume     |
| ApproveWorkflow        | POST   | /api/workflows/[workflow_id]/approve    |
| GetTasksByWorkflow     | GET    | /api/workflows/[workflow_id]/tasks      |
| GetTaskById            | GET    | /api/tasks/[task_id]                    |
| GetTaskRuns            | GET    | /api/tasks/[task_id]/runs               |
| GetGateways            | GET    | /api/gateways                           |
| GetGatewayById         | GET    | /api/gateways/[gateway_id]             |
| RegisterGateway        | POST   | /api/gateways/register                  |
| GatewayHeartbeat       | POST   | /api/gateways/[gateway_id]/heartbeat   |
| DeleteGateway          | DELETE | /api/gateways/[gateway_id]             |
| GetComplianceReports   | GET    | /api/compliance/reports                 |
| GetComplianceReportById| GET    | /api/compliance/reports/[report_id]     |
| GenerateComplianceReport| POST  | /api/compliance/reports/generate        |
| HealthCheck            | GET    | /api/health                             |

---

## Schritt 4: Data Types importieren

### 4.1 Custom Data Types erstellen

Navigiere zu **Data Types** → **Add Data Type** und erstelle alle Types aus `flutterflow_data_types.json`.

#### WorkflowModel

1. **Add Data Type** → Name: `WorkflowModel`
2. Fields hinzufügen:

| Field      | Type     | Nullable |
|------------|----------|----------|
| id         | String   | Nein     |
| tenantId   | String   | Nein     |
| title      | String   | Nein     |
| goal       | String   | Ja       |
| status     | String   | Nein     |
| config     | JSON     | Ja       |
| createdAt  | DateTime | Nein     |
| updatedAt  | DateTime | Ja       |
| runCount   | Integer  | Nein     |

3. **JSON Mapping** konfigurieren (snake_case → camelCase wie in `jsonMapping`-Sektion)

Wiederhole für: `TaskModel`, `AgentRunModel`, `GatewayModel`, `ComplianceReportModel`, `UserModel`, `TenantModel`

### 4.2 Enum: WorkflowStatus

Erstelle **Custom Enum** `WorkflowStatus`:
- `draft`
- `active`
- `paused`
- `completed`
- `failed`
- `pending_approval`

### 4.3 Enum: AgentType

Erstelle **Custom Enum** `AgentType`:
- `devops`
- `marketing`
- `compliance`
- `research`
- `manager`

---

## Schritt 5: Workflow-Liste Page mit ListView

### 5.1 Page erstellen: WorkflowListPage

1. **Add Page** → Name: `WorkflowListPage`
2. Layout: Scaffold mit AppBar + Body

### 5.2 Widgets

```
Scaffold
├── AppBar
│   ├── Title: "Workflows"
│   └── Actions: [IconButton(Icons.add, → CreateWorkflowPage)]
└── Body
    └── Column
        ├── [Loading State] CircularProgressIndicator (sichtbar während API-Call)
        ├── [Error State] Text("Fehler beim Laden") + RetryButton
        └── ListView.builder (expanded)
            └── WorkflowCard (Custom Widget)
                ├── Icon (je nach Status: play/pause/check/error)
                ├── Column
                │   ├── Text(workflow.title, style: titleMedium)
                │   ├── Text(workflow.goal, maxLines: 2, overflow: ellipsis)
                │   └── Row
                │       ├── StatusChip(workflow.status)
                │       └── Text("${workflow.runCount} Runs")
                └── IconButton(more_vert, → WorkflowDetailPage)
```

### 5.3 Page Action: initState / onPageLoad

```
1. [Action] Update App State: isLoadingWorkflows = true
2. [Action] Call API: GetWorkflows
   - Query Params: page = 1, limit = 20
3. [Condition] If Response OK (200)
   → [Action] Update Page State: workflows = parseWorkflowList(response)
4. [Else]
   → [Action] Update Page State: hasError = true
5. [Action] Update App State: isLoadingWorkflows = false
```

### 5.4 WorkflowCard Status-Farben

| Status           | Farbe       | Icon              |
|------------------|-------------|-------------------|
| draft            | Grey        | edit              |
| active           | Green       | play_arrow        |
| paused           | Orange      | pause             |
| completed        | Blue        | check_circle      |
| failed           | Red         | error             |
| pending_approval | Purple      | pending_actions   |

---

## Schritt 6: Workflow ausführen (Execute Button mit Loading State)

### 6.1 Widget: ExecuteWorkflowButton

Erstelle einen **Custom Widget** oder verwende einen Standard-Button mit State-Management:

```
// Page State Variables:
// - isExecuting: Boolean = false
// - lastRunId: String = ""
// - executeError: String = ""

ElevatedButton(
  onPressed: isExecuting ? null : _executeWorkflow,
  child: isExecuting
    ? Row(children: [
        CircularProgressIndicator(strokeWidth: 2, color: white),
        SizedBox(width: 8),
        Text("Wird ausgeführt..."),
      ])
    : Row(children: [
        Icon(Icons.play_arrow),
        Text("Workflow ausführen"),
      ]),
)
```

### 6.2 Execute Action Flow

```
1. [Action] Update Page State: isExecuting = true, executeError = ""
2. [Action] Call API: ExecuteWorkflow
   - Path Param: workflow_id = currentWorkflow.id
   - Body: { "gateway_id": selectedGatewayId }
3. [Condition] If Response OK (202)
   → [Action] Update Page State: lastRunId = response.body.json['run_id']
   → [Action] Show Snack Bar: "Workflow gestartet! Run ID: ${lastRunId}"
   → [Action] Navigate To: WorkflowRunDetailPage (pass: run_id)
4. [Else If] Status 402 (Plan Limit)
   → [Action] Update Page State: executeError = response.body.json['detail']
   → [Action] Show Dialog: PlanUpgradeDialog
5. [Else]
   → [Action] Update Page State: executeError = response.body.json['detail']
   → [Action] Show Snack Bar Error: executeError
6. [Action] Update Page State: isExecuting = false
```

### 6.3 PlanUpgradeDialog Widget

```
AlertDialog(
  title: Text("Plan-Limit erreicht"),
  content: Column(
    children: [
      Icon(Icons.upgrade, size: 48, color: orange),
      Text(executeError),
      Text("Upgrade auf Professional für mehr Kapazität"),
    ],
  ),
  actions: [
    TextButton("Abbrechen", onPressed: dismiss),
    ElevatedButton("Jetzt upgraden",
      onPressed: launchBillingPortal), // → POST /billing/portal
  ],
)
```

---

## Schritt 7: Echtzeit-Updates via Polling (Timer-Widget, 5s Interval)

FlutterFlow unterstützt kein natives WebSocket-Widget, daher wird Polling verwendet.

### 7.1 Timer-basiertes Polling auf WorkflowDetailPage

```
// Page State Variables:
// - pollingTimer: Timer? (via Custom Action)
// - isPollingActive: Boolean = false
```

### 7.2 Custom Action: startWorkflowPolling

```dart
import 'dart:async';

// Custom Action: startWorkflowPolling
Future<void> startWorkflowPolling(String workflowId) async {
  // Alten Timer stoppen falls vorhanden
  FFAppState().pollingTimer?.cancel();

  FFAppState().isPollingActive = true;

  FFAppState().pollingTimer = Timer.periodic(
    const Duration(seconds: 5),
    (timer) async {
      if (!FFAppState().isPollingActive) {
        timer.cancel();
        return;
      }

      // API aufrufen
      final response = await ApiCallsGroup.getWorkflowByIdCall(
        workflowId: workflowId,
        authToken: FFAppState().authToken,
      );

      if (response.succeeded) {
        // App State mit neuem Status aktualisieren
        final newStatus = GetWorkflowByIdCall.status(response.jsonBody);
        FFAppState().currentWorkflowStatus = newStatus;

        // Polling stoppen wenn Endzustand erreicht
        if (['completed', 'failed'].contains(newStatus)) {
          timer.cancel();
          FFAppState().isPollingActive = false;
        }
      }
    },
  );
}
```

### 7.3 Custom Action: stopWorkflowPolling

```dart
// Custom Action: stopWorkflowPolling
Future<void> stopWorkflowPolling() async {
  FFAppState().pollingTimer?.cancel();
  FFAppState().isPollingActive = false;
}
```

### 7.4 Integration in Page Lifecycle

```
// onPageLoad:
→ [Action] Call Custom Action: startWorkflowPolling(workflowId)

// onPageDispose (Back-Button / Navigation Away):
→ [Action] Call Custom Action: stopWorkflowPolling()
```

### 7.5 UI: Polling Status Indicator

```
Row(
  children: [
    if (isPollingActive) ...[
      SizedBox(
        width: 12,
        height: 12,
        child: CircularProgressIndicator(strokeWidth: 1.5),
      ),
      SizedBox(width: 6),
      Text("Live-Update aktiv", style: caption, color: green),
    ] else
      Text("Kein Live-Update", style: caption, color: grey),
    Spacer(),
    TextButton(
      onPressed: isPollingActive
        ? stopWorkflowPolling
        : () => startWorkflowPolling(workflowId),
      child: Text(isPollingActive ? "Pause" : "Starten"),
    ),
  ],
)
```

---

## Tipps & Best Practices

### Fehlerbehandlung
- Alle API Calls sollten auf Status-Codes prüfen: 200/201/202 = Erfolg, 400/401/402/403/404/422/500 = Fehler
- Bei 401: Token-Refresh versuchen, dann erneut. Bei erneutem 401 → Logout
- Bei 402: Plan-Upgrade Dialog anzeigen
- RFC 9457 Format: Fehlermeldung aus `response.body.json['detail']` lesen

### Performance
- Paginierung immer nutzen (page + limit Parameter)
- ListView mit `itemExtent` für bessere Performance bei langen Listen
- Images lazy laden via `CachedNetworkImage`

### Sicherheit
- `authToken` und `refreshToken` nur in App State (FlutterFlow verschlüsselt Persist-Daten)
- Niemals Tokens in Logs ausgeben
- HTTPS immer für `apiBaseUrl` verwenden (kein HTTP in Produktion)

---

*Letzte Aktualisierung: RealSyncDynamics Agent-OS v1.0 | FlutterFlow Integration Guide*
