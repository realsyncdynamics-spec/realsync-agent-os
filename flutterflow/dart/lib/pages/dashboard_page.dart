// ============================================================
// dashboard_page.dart
// RealSyncDynamics Agent-OS — Dashboard-Hauptseite
//
// FlutterFlow-Hinweis:
//   - Route: '/dashboard'
//   - Polling alle 5 Sekunden via Timer.periodic
//   - BottomNavigationBar: 0=Dashboard, 1=Workflows, 2=Gateways, 3=Compliance
//   - FAB öffnet Workflow-Erstellen-Dialog oder navigiert zu /workflows/create
// ============================================================

import 'dart:async';
import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../widgets/status_chip.dart';
import '../widgets/workflow_card.dart';

class DashboardPage extends StatefulWidget {
  const DashboardPage({super.key});

  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends State<DashboardPage> {
  // ─── State ──────────────────────────────────────────────────
  int _selectedNavIndex = 0;
  bool _isLoading = true;
  bool _hasError = false;
  String _errorMessage = '';

  // KPI-Daten
  int _activeWorkflows = 0;
  int _runningTasks = 0;
  int _gatewaysOnline = 0;
  int _agentRunsToday = 0;

  // Letzte 5 Workflows
  List<dynamic> _recentWorkflows = [];

  // Polling-Timer
  Timer? _pollingTimer;

  // ─── Brand Colors ────────────────────────────────────────────
  static const Color _brandTeal = Color(0xFF01696F);

  // ─── Lifecycle ───────────────────────────────────────────────
  @override
  void initState() {
    super.initState();
    _loadData();
    // Polling alle 5 Sekunden
    _pollingTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _loadData(silent: true),
    );
  }

  @override
  void dispose() {
    _pollingTimer?.cancel();
    super.dispose();
  }

  // ─── Data Loading ────────────────────────────────────────────

  Future<void> _loadData({bool silent = false}) async {
    if (!silent && mounted) {
      setState(() {
        _isLoading = true;
        _hasError = false;
      });
    }

    try {
      // Parallele API-Calls für bessere Performance
      final results = await Future.wait([
        ApiService.getDashboardStats(),
        ApiService.getWorkflows(page: 1, limit: 5),
      ]);

      final stats = results[0] as Map<String, dynamic>;
      final workflows = results[1] as List<dynamic>;

      if (mounted) {
        setState(() {
          _activeWorkflows = (stats['active_workflows'] as num?)?.toInt() ?? 0;
          _runningTasks = (stats['running_tasks'] as num?)?.toInt() ?? 0;
          _gatewaysOnline = (stats['gateways_online'] as num?)?.toInt() ?? 0;
          _agentRunsToday = (stats['agent_runs_today'] as num?)?.toInt() ?? 0;
          _recentWorkflows = workflows;
          _isLoading = false;
          _hasError = false;
        });
      }
    } catch (e) {
      if (mounted && !silent) {
        setState(() {
          _isLoading = false;
          _hasError = true;
          _errorMessage = e.toString().replaceFirst('Exception: ', '');
        });
      }
    }
  }

  Future<void> _handleLogout() async {
    await ApiService.logout();
    if (mounted) {
      Navigator.pushReplacementNamed(context, '/login');
    }
  }

  void _onNavTap(int index) {
    setState(() => _selectedNavIndex = index);
    switch (index) {
      case 1:
        Navigator.pushNamed(context, '/workflows');
        break;
      case 2:
        Navigator.pushNamed(context, '/gateways');
        break;
      case 3:
        Navigator.pushNamed(context, '/compliance');
        break;
    }
  }

  // ─── Build ───────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.grey.shade50,
      appBar: AppBar(
        backgroundColor: _brandTeal,
        foregroundColor: Colors.white,
        elevation: 0,
        title: const Row(
          children: [
            Text(
              'RS',
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 18,
                color: Colors.white,
              ),
            ),
            SizedBox(width: 8),
            Text(
              'Agent-OS',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w400,
                color: Colors.white70,
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.notifications_outlined),
            onPressed: () {}, // TODO: Notifications
            tooltip: 'Benachrichtigungen',
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: _handleLogout,
            tooltip: 'Abmelden',
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _hasError
              ? _buildErrorState()
              : RefreshIndicator(
                  onRefresh: () => _loadData(),
                  color: _brandTeal,
                  child: SingleChildScrollView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // ── KPI-Cards Grid ──────────────────────
                        _buildKpiSection(),
                        const SizedBox(height: 24),

                        // ── Letzte Workflows ────────────────────
                        _buildRecentWorkflowsSection(),
                        const SizedBox(height: 100), // FAB-Abstand
                      ],
                    ),
                  ),
                ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => Navigator.pushNamed(context, '/workflows/create'),
        backgroundColor: _brandTeal,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add),
        label: const Text(
          'Workflow erstellen',
          style: TextStyle(fontWeight: FontWeight.w600),
        ),
      ),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _selectedNavIndex,
        onTap: _onNavTap,
        type: BottomNavigationBarType.fixed,
        selectedItemColor: _brandTeal,
        unselectedItemColor: Colors.grey,
        items: const [
          BottomNavigationBarItem(
            icon: Icon(Icons.dashboard_outlined),
            activeIcon: Icon(Icons.dashboard),
            label: 'Dashboard',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.account_tree_outlined),
            activeIcon: Icon(Icons.account_tree),
            label: 'Workflows',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.router_outlined),
            activeIcon: Icon(Icons.router),
            label: 'Gateways',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.verified_outlined),
            activeIcon: Icon(Icons.verified),
            label: 'Compliance',
          ),
        ],
      ),
    );
  }

  // ─── Section Widgets ─────────────────────────────────────────

  Widget _buildKpiSection() {
    return Container(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Übersicht',
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.bold,
              color: Colors.black87,
            ),
          ),
          const SizedBox(height: 12),
          GridView.count(
            crossAxisCount: 2,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            crossAxisSpacing: 12,
            mainAxisSpacing: 12,
            childAspectRatio: 1.5,
            children: [
              _buildKpiCard(
                label: 'Aktive Workflows',
                value: _activeWorkflows,
                icon: Icons.account_tree_outlined,
                color: const Color(0xFF2E7D32),
                backgroundColor: const Color(0xFFE8F5E9),
              ),
              _buildKpiCard(
                label: 'Laufende Tasks',
                value: _runningTasks,
                icon: Icons.task_alt,
                color: const Color(0xFF1565C0),
                backgroundColor: const Color(0xFFE3F2FD),
              ),
              _buildKpiCard(
                label: 'Gateways Online',
                value: _gatewaysOnline,
                icon: Icons.router_outlined,
                color: _brandTeal,
                backgroundColor: const Color(0xFFE0F2F1),
              ),
              _buildKpiCard(
                label: 'Agent-Runs heute',
                value: _agentRunsToday,
                icon: Icons.smart_toy_outlined,
                color: const Color(0xFFE65100),
                backgroundColor: const Color(0xFFFFF3E0),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildKpiCard({
    required String label,
    required int value,
    required IconData icon,
    required Color color,
    required Color backgroundColor,
  }) {
    return Card(
      elevation: 1,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: color.withOpacity(0.2)),
      ),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: backgroundColor,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Icon(icon, size: 22, color: color),
                // Live-Indicator Punkt
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: color,
                    shape: BoxShape.circle,
                  ),
                ),
              ],
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  value.toString(),
                  style: TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.bold,
                    color: color,
                    height: 1,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 11,
                    color: color.withOpacity(0.8),
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRecentWorkflowsSection() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'Letzte Workflows',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: Colors.black87,
                ),
              ),
              TextButton(
                onPressed: () => Navigator.pushNamed(context, '/workflows'),
                child: Text(
                  'Alle anzeigen',
                  style: TextStyle(color: _brandTeal),
                ),
              ),
            ],
          ),
        ),
        if (_recentWorkflows.isEmpty)
          _buildEmptyWorkflowsState()
        else
          ...(_recentWorkflows.map((workflow) => WorkflowCard(
                workflow: workflow as Map<String, dynamic>,
                onTap: () => Navigator.pushNamed(
                  context,
                  '/workflows/${workflow['id']}',
                  arguments: workflow,
                ),
              ))),
      ],
    );
  }

  Widget _buildEmptyWorkflowsState() {
    return Container(
      margin: const EdgeInsets.all(16),
      padding: const EdgeInsets.all(32),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Column(
        children: [
          Icon(Icons.account_tree_outlined,
              size: 48, color: Colors.grey.shade400),
          const SizedBox(height: 12),
          Text(
            'Noch keine Workflows',
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w600,
              color: Colors.grey.shade600,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'Erstelle deinen ersten Workflow mit dem + Button.',
            style: TextStyle(fontSize: 13, color: Colors.grey.shade500),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }

  Widget _buildErrorState() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.cloud_off, size: 64, color: Colors.grey.shade400),
            const SizedBox(height: 16),
            Text(
              'Verbindungsfehler',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.bold,
                color: Colors.grey.shade700,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              _errorMessage,
              style: TextStyle(color: Colors.grey.shade600),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            ElevatedButton.icon(
              onPressed: _loadData,
              icon: const Icon(Icons.refresh),
              label: const Text('Erneut versuchen'),
              style: ElevatedButton.styleFrom(
                backgroundColor: _brandTeal,
                foregroundColor: Colors.white,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
