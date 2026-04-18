// ============================================================
// api_service.dart
// RealSyncDynamics Agent-OS — API Service
//
// FlutterFlow-Hinweis:
//   - Setze baseUrl auf deine Cloud Run URL (TODO-Marker unten)
//   - Dieser Service wird als Singleton genutzt (nur static Methoden)
//   - Token-Speicherung über shared_preferences (Gerät-lokal)
// ============================================================

import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

class ApiService {
  // TODO: Ändere diese URL auf deine deployte Cloud Run / Backend URL
  static const String baseUrl = 'https://YOUR_CLOUD_RUN_URL';

  // ─── Shared-Preferences Keys ────────────────────────────────
  static const String _tokenKey = 'auth_token';
  static const String _refreshTokenKey = 'refresh_token';

  // ─── Token Management ───────────────────────────────────────

  /// Liest den gespeicherten JWT-Access-Token vom Gerät.
  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_tokenKey);
  }

  /// Speichert den JWT-Access-Token lokal auf dem Gerät.
  static Future<void> saveToken(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
  }

  /// Speichert den Refresh-Token lokal auf dem Gerät.
  static Future<void> saveRefreshToken(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_refreshTokenKey, token);
  }

  /// Löscht alle gespeicherten Tokens (für Logout).
  static Future<void> clearTokens() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
    await prefs.remove(_refreshTokenKey);
  }

  // ─── HTTP Helpers ────────────────────────────────────────────

  /// Gibt Standard-Headers zurück, inklusive Bearer-Token wenn vorhanden.
  static Future<Map<String, String>> _headers({bool requireAuth = true}) async {
    final headers = <String, String>{
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (requireAuth) {
      final token = await getToken();
      if (token != null && token.isNotEmpty) {
        headers['Authorization'] = 'Bearer $token';
      }
    }
    return headers;
  }

  /// Parst die API-Response und wirft eine Exception bei Fehler.
  static Map<String, dynamic> _parseResponse(http.Response response) {
    final body = jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return body;
    } else {
      final message = body['message'] ??
          body['detail'] ??
          body['error'] ??
          'Unbekannter Fehler (${response.statusCode})';
      throw Exception(message);
    }
  }

  // ─── Auth Endpoints ──────────────────────────────────────────

  /// Meldet den Nutzer an. Gibt Nutzer-Daten und Token zurück.
  /// Speichert Token automatisch lokal.
  ///
  /// Beispiel-Response:
  /// { "access_token": "...", "refresh_token": "...", "user": { ... } }
  static Future<Map<String, dynamic>> login(
      String email, String password) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/v1/auth/login'),
      headers: await _headers(requireAuth: false),
      body: jsonEncode({'email': email, 'password': password}),
    );
    final data = _parseResponse(response);
    if (data['access_token'] != null) {
      await saveToken(data['access_token'] as String);
    }
    if (data['refresh_token'] != null) {
      await saveRefreshToken(data['refresh_token'] as String);
    }
    return data;
  }

  /// Registriert einen neuen Nutzer mit Organisation.
  /// Speichert Token bei Erfolg automatisch.
  ///
  /// [plan]: 'free' | 'starter' | 'professional'
  static Future<Map<String, dynamic>> register(
    String email,
    String password,
    String name,
    String orgName, {
    String plan = 'free',
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/v1/auth/register'),
      headers: await _headers(requireAuth: false),
      body: jsonEncode({
        'email': email,
        'password': password,
        'name': name,
        'org_name': orgName,
        'plan': plan,
      }),
    );
    final data = _parseResponse(response);
    if (data['access_token'] != null) {
      await saveToken(data['access_token'] as String);
    }
    if (data['refresh_token'] != null) {
      await saveRefreshToken(data['refresh_token'] as String);
    }
    return data;
  }

  /// Meldet den Nutzer ab und löscht lokale Tokens.
  static Future<void> logout() async {
    try {
      await http.post(
        Uri.parse('$baseUrl/api/v1/auth/logout'),
        headers: await _headers(),
      );
    } catch (_) {
      // Auch bei Netzwerkfehler lokal ausloggen
    } finally {
      await clearTokens();
    }
  }

  // ─── Workflow Endpoints ──────────────────────────────────────

  /// Lädt eine paginierte Liste aller Workflows der Organisation.
  ///
  /// [page]: Seitennummer (ab 1)
  /// [limit]: Anzahl pro Seite
  static Future<List<dynamic>> getWorkflows(
      {int page = 1, int limit = 20}) async {
    final uri = Uri.parse('$baseUrl/api/v1/workflows')
        .replace(queryParameters: {'page': '$page', 'limit': '$limit'});
    final response = await http.get(uri, headers: await _headers());
    final data = _parseResponse(response);
    // API kann { "workflows": [...] } oder direkt [...] zurückgeben
    if (data['workflows'] != null) {
      return data['workflows'] as List<dynamic>;
    } else if (data['items'] != null) {
      return data['items'] as List<dynamic>;
    }
    return [];
  }

  /// Lädt Details eines einzelnen Workflows per ID.
  static Future<Map<String, dynamic>> getWorkflow(String id) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/v1/workflows/$id'),
      headers: await _headers(),
    );
    return _parseResponse(response);
  }

  /// Erstellt einen neuen Workflow.
  ///
  /// [data] muss mindestens enthalten:
  /// { "name": "...", "goal": "...", "agents": [...] }
  static Future<Map<String, dynamic>> createWorkflow(
      Map<String, dynamic> data) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/v1/workflows'),
      headers: await _headers(),
      body: jsonEncode(data),
    );
    return _parseResponse(response);
  }

  /// Aktualisiert einen bestehenden Workflow.
  static Future<Map<String, dynamic>> updateWorkflow(
      String id, Map<String, dynamic> data) async {
    final response = await http.put(
      Uri.parse('$baseUrl/api/v1/workflows/$id'),
      headers: await _headers(),
      body: jsonEncode(data),
    );
    return _parseResponse(response);
  }

  /// Startet die Ausführung eines Workflows.
  static Future<Map<String, dynamic>> executeWorkflow(String id) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/v1/workflows/$id/execute'),
      headers: await _headers(),
    );
    return _parseResponse(response);
  }

  /// Pausiert einen laufenden Workflow.
  static Future<Map<String, dynamic>> pauseWorkflow(String id) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/v1/workflows/$id/pause'),
      headers: await _headers(),
    );
    return _parseResponse(response);
  }

  /// Setzt einen pausierten Workflow fort.
  static Future<Map<String, dynamic>> resumeWorkflow(String id) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/v1/workflows/$id/resume'),
      headers: await _headers(),
    );
    return _parseResponse(response);
  }

  /// Genehmigt einen Workflow, der auf menschliche Freigabe wartet.
  static Future<Map<String, dynamic>> approveWorkflow(
      String id, String comment) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/v1/workflows/$id/approve'),
      headers: await _headers(),
      body: jsonEncode({'comment': comment, 'approved': true}),
    );
    return _parseResponse(response);
  }

  /// Lehnt einen Workflow ab.
  static Future<Map<String, dynamic>> rejectWorkflow(
      String id, String reason) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/v1/workflows/$id/approve'),
      headers: await _headers(),
      body: jsonEncode({'comment': reason, 'approved': false}),
    );
    return _parseResponse(response);
  }

  // ─── Gateway Endpoints ───────────────────────────────────────

  /// Lädt alle registrierten Gateways der Organisation.
  static Future<List<dynamic>> getGateways() async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/v1/gateways'),
      headers: await _headers(),
    );
    final data = _parseResponse(response);
    if (data['gateways'] != null) {
      return data['gateways'] as List<dynamic>;
    } else if (data['items'] != null) {
      return data['items'] as List<dynamic>;
    }
    return [];
  }

  /// Registriert ein neues Gateway.
  static Future<Map<String, dynamic>> registerGateway(
      Map<String, dynamic> data) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/v1/gateways'),
      headers: await _headers(),
      body: jsonEncode(data),
    );
    return _parseResponse(response);
  }

  // ─── Compliance Endpoints ─────────────────────────────────────

  /// Lädt alle Compliance-Reports der Organisation.
  static Future<List<dynamic>> getComplianceReports() async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/v1/compliance/reports'),
      headers: await _headers(),
    );
    final data = _parseResponse(response);
    if (data['reports'] != null) {
      return data['reports'] as List<dynamic>;
    } else if (data['items'] != null) {
      return data['items'] as List<dynamic>;
    }
    return [];
  }

  /// Lädt einen spezifischen Compliance-Report.
  static Future<Map<String, dynamic>> getComplianceReport(String id) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/v1/compliance/reports/$id'),
      headers: await _headers(),
    );
    return _parseResponse(response);
  }

  // ─── Dashboard / Stats Endpoints ─────────────────────────────

  /// Lädt Dashboard-Statistiken (KPIs).
  static Future<Map<String, dynamic>> getDashboardStats() async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/v1/dashboard/stats'),
      headers: await _headers(),
    );
    return _parseResponse(response);
  }

  // ─── Health Check ─────────────────────────────────────────────

  /// Prüft ob das Backend erreichbar ist. Gibt true zurück wenn online.
  static Future<bool> checkHealth() async {
    try {
      final response = await http
          .get(
            Uri.parse('$baseUrl/health'),
            headers: {'Accept': 'application/json'},
          )
          .timeout(const Duration(seconds: 5));
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}
