// ============================================================
// workflows_page.dart
// RealSyncDynamics Agent-OS — Workflow-Liste
//
// FlutterFlow-Hinweis:
//   - Route: '/workflows'
//   - Filter-Bar mit Status-Chips (Alle / Active / Paused / Error)
//   - Search-Bar filtert lokal über Titel und Goal
//   - FAB: Neuen Workflow erstellen
//   - Pull-to-Refresh
// ============================================================

import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../widgets/workflow_card.dart';

class WorkflowsPage extends StatefulWidget {
  const WorkflowsPage({super.key});

  @override
  State<WorkflowsPage> createState() => _WorkflowsPageState();
}

class _WorkflowsPageState extends State<WorkflowsPage> {
  // ─── State ──────────────────────────────────────────────────
  bool _isLoading = true;
  bool _hasError = false;
  String _errorMessage = '';

  List<dynamic> _allWorkflows = [];
  List<dynamic> _filteredWorkflows = [];

  String _selectedFilter = 'all';
  String _searchQuery = '';

  final TextEditingController _searchController = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  // Paginierung
  int _currentPage = 1;
  bool _isLoadingMore = false;
  bool _hasMore = true;
  static const int _pageSize = 20;

  // ─── Brand Colors ────────────────────────────────────────────
  static const Color _brandTeal = Color(0xFF01696F);

  // ─── Filter-Definitionen ─────────────────────────────────────
  final List<Map<String, String>> _filters = [
    {'value': 'all', 'label': 'Alle'},
    {'value': 'active', 'label': 'Aktiv'},
    {'value': 'running', 'label': 'Läuft'},
    {'value': 'paused', 'label': 'Pausiert'},
    {'value': 'error', 'label': 'Fehler'},
    {'value': 'draft', 'label': 'Entwurf'},
  ];

  // ─── Lifecycle ───────────────────────────────────────────────
  @override
  void initState() {
    super.initState();
    _loadWorkflows();
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _searchController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  // ─── Data Loading ────────────────────────────────────────────

  Future<void> _loadWorkflows({bool refresh = false}) async {
    if (refresh) {
      setState(() {
        _currentPage = 1;
        _hasMore = true;
        _allWorkflows = [];
      });
    }

    if (mounted) setState(() => _isLoading = _allWorkflows.isEmpty);

    try {
      final workflows = await ApiService.getWorkflows(
        page: _currentPage,
        limit: _pageSize,
      );

      if (mounted) {
        setState(() {
          _allWorkflows = [..._allWorkflows, ...workflows];
          _hasMore = workflows.length == _pageSize;
          _isLoading = false;
          _hasError = false;
        });
        _applyFilters();
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _isLoading = false;
          _hasError = true;
          _errorMessage = e.toString().replaceFirst('Exception: ', '');
        });
      }
    }
  }

  Future<void> _loadMore() async {
    if (_isLoadingMore || !_hasMore) return;
    setState(() => _isLoadingMore = true);
    _currentPage++;
    await _loadWorkflows();
    setState(() => _isLoadingMore = false);
  }

  void _onScroll() {
    if (_scrollController.position.pixels >=
        _scrollController.position.maxScrollExtent - 200) {
      _loadMore();
    }
  }

  void _applyFilters() {
    var filtered = List<dynamic>.from(_allWorkflows);

    // Status-Filter
    if (_selectedFilter != 'all') {
      filtered = filtered
          .where((w) =>
              (w as Map<String, dynamic>)['status'] == _selectedFilter)
          .toList();
    }

    // Suche
    if (_searchQuery.isNotEmpty) {
      final query = _searchQuery.toLowerCase();
      filtered = filtered.where((w) {
        final workflow = w as Map<String, dynamic>;
        final name = (workflow['name'] as String? ?? '').toLowerCase();
        final goal = (workflow['goal'] as String? ?? '').toLowerCase();
        return name.contains(query) || goal.contains(query);
      }).toList();
    }

    setState(() => _filteredWorkflows = filtered);
  }

  void _onFilterChanged(String filter) {
    setState(() => _selectedFilter = filter);
    _applyFilters();
  }

  void _onSearchChanged(String query) {
    setState(() => _searchQuery = query);
    _applyFilters();
  }

  // ─── Build ───────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.grey.shade50,
      appBar: AppBar(
        backgroundColor: _brandTeal,
        foregroundColor: Colors.white,
        title: const Text(
          'Workflows',
          style: TextStyle(fontWeight: FontWeight.w600),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.sort_outlined),
            onPressed: _showSortDialog,
            tooltip: 'Sortieren',
          ),
        ],
      ),
      body: Column(
        children: [
          // ── Search-Bar ───────────────────────────────────────
          _buildSearchBar(),

          // ── Filter-Chips ─────────────────────────────────────
          _buildFilterBar(),

          // ── Workflow-Liste ───────────────────────────────────
          Expanded(
            child: _isLoading
                ? const Center(child: CircularProgressIndicator())
                : _hasError
                    ? _buildErrorState()
                    : _filteredWorkflows.isEmpty
                        ? _buildEmptyState()
                        : RefreshIndicator(
                            onRefresh: () => _loadWorkflows(refresh: true),
                            color: _brandTeal,
                            child: ListView.builder(
                              controller: _scrollController,
                              padding: const EdgeInsets.only(
                                  top: 8, bottom: 100),
                              itemCount: _filteredWorkflows.length +
                                  (_isLoadingMore ? 1 : 0),
                              itemBuilder: (context, index) {
                                if (index == _filteredWorkflows.length) {
                                  return const Center(
                                    child: Padding(
                                      padding: EdgeInsets.all(16.0),
                                      child: CircularProgressIndicator(),
                                    ),
                                  );
                                }
                                final workflow = _filteredWorkflows[index]
                                    as Map<String, dynamic>;
                                return WorkflowCard(
                                  workflow: workflow,
                                  onTap: () => Navigator.pushNamed(
                                    context,
                                    '/workflows/${workflow['id']}',
                                    arguments: workflow,
                                  ),
                                );
                              },
                            ),
                          ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () =>
            Navigator.pushNamed(context, '/workflows/create'),
        backgroundColor: _brandTeal,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add),
        label: const Text(
          'Neuer Workflow',
          style: TextStyle(fontWeight: FontWeight.w600),
        ),
      ),
    );
  }

  // ─── Section Widgets ─────────────────────────────────────────

  Widget _buildSearchBar() {
    return Container(
      color: _brandTeal,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      child: TextField(
        controller: _searchController,
        onChanged: _onSearchChanged,
        style: const TextStyle(color: Colors.white),
        decoration: InputDecoration(
          hintText: 'Workflow suchen...',
          hintStyle: TextStyle(color: Colors.white.withOpacity(0.7)),
          prefixIcon: Icon(Icons.search, color: Colors.white.withOpacity(0.7)),
          suffixIcon: _searchQuery.isNotEmpty
              ? IconButton(
                  icon:
                      Icon(Icons.clear, color: Colors.white.withOpacity(0.7)),
                  onPressed: () {
                    _searchController.clear();
                    _onSearchChanged('');
                  },
                )
              : null,
          filled: true,
          fillColor: Colors.white.withOpacity(0.15),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: BorderSide.none,
          ),
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        ),
      ),
    );
  }

  Widget _buildFilterBar() {
    return Container(
      height: 50,
      color: Colors.white,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        children: _filters.map((filter) {
          final isSelected = _selectedFilter == filter['value'];
          return Padding(
            padding: const EdgeInsets.only(right: 8),
            child: FilterChip(
              label: Text(filter['label']!),
              selected: isSelected,
              onSelected: (_) => _onFilterChanged(filter['value']!),
              selectedColor: _brandTeal.withOpacity(0.15),
              checkmarkColor: _brandTeal,
              labelStyle: TextStyle(
                color: isSelected ? _brandTeal : Colors.black54,
                fontWeight:
                    isSelected ? FontWeight.w600 : FontWeight.normal,
                fontSize: 12,
              ),
              side: BorderSide(
                color: isSelected ? _brandTeal : Colors.grey.shade300,
              ),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(20),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 4),
            ),
          );
        }).toList(),
      ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.search_off, size: 64, color: Colors.grey.shade400),
          const SizedBox(height: 16),
          Text(
            _searchQuery.isNotEmpty || _selectedFilter != 'all'
                ? 'Keine Workflows gefunden'
                : 'Noch keine Workflows',
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              color: Colors.grey.shade600,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            _searchQuery.isNotEmpty
                ? 'Versuche einen anderen Suchbegriff'
                : 'Erstelle deinen ersten Workflow',
            style: TextStyle(color: Colors.grey.shade500),
          ),
        ],
      ),
    );
  }

  Widget _buildErrorState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.error_outline, size: 64, color: Colors.red.shade400),
          const SizedBox(height: 16),
          Text(
            'Fehler beim Laden',
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
            onPressed: () => _loadWorkflows(refresh: true),
            icon: const Icon(Icons.refresh),
            label: const Text('Erneut versuchen'),
            style: ElevatedButton.styleFrom(
              backgroundColor: _brandTeal,
              foregroundColor: Colors.white,
            ),
          ),
        ],
      ),
    );
  }

  void _showSortDialog() {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Sortieren nach',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 16),
            ListTile(
              leading: const Icon(Icons.access_time),
              title: const Text('Letzter Run'),
              onTap: () {
                Navigator.pop(ctx);
                // TODO: Implementiere Sortierung
              },
            ),
            ListTile(
              leading: const Icon(Icons.sort_by_alpha),
              title: const Text('Name (A-Z)'),
              onTap: () {
                Navigator.pop(ctx);
                setState(() {
                  _filteredWorkflows.sort((a, b) {
                    final aName = (a as Map)['name'] as String? ?? '';
                    final bName = (b as Map)['name'] as String? ?? '';
                    return aName.compareTo(bName);
                  });
                });
              },
            ),
            ListTile(
              leading: const Icon(Icons.fiber_manual_record),
              title: const Text('Status'),
              onTap: () {
                Navigator.pop(ctx);
                // TODO: Implementiere Status-Sortierung
              },
            ),
          ],
        ),
      ),
    );
  }
}
