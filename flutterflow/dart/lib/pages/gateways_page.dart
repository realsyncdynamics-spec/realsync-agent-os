// ============================================================
// gateways_page.dart
// RealSyncDynamics Agent-OS — Gateway-Management-Seite
//
// FlutterFlow-Hinweis:
//   - Route: '/gateways'
//   - Zeigt alle registrierten Gateways mit Status-Indicator
//   - FAB öffnet Install-Anleitung als BottomSheet
//   - Pull-to-Refresh
// ============================================================

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import '../services/api_service.dart';
import '../widgets/status_chip.dart';

class GatewaysPage extends StatefulWidget {
  const GatewaysPage({super.key});

  @override
  State<GatewaysPage> createState() => _GatewaysPageState();
}

class _GatewaysPageState extends State<GatewaysPage> {
  // ─── State ──────────────────────────────────────────────────
  bool _isLoading = true;
  bool _hasError = false;
  String _errorMessage = '';
  List<dynamic> _gateways = [];

  // ─── Brand Colors ────────────────────────────────────────────
  static const Color _brandTeal = Color(0xFF01696F);

  // ─── Lifecycle ───────────────────────────────────────────────
  @override
  void initState() {
    super.initState();
    _loadGateways();
  }

  // ─── Data Loading ────────────────────────────────────────────

  Future<void> _loadGateways() async {
    setState(() {
      _isLoading = true;
      _hasError = false;
    });

    try {
      final gateways = await ApiService.getGateways();
      if (mounted) {
        setState(() {
          _gateways = gateways;
          _isLoading = false;
        });
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

  // ─── Build ───────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.grey.shade50,
      appBar: AppBar(
        backgroundColor: _brandTeal,
        foregroundColor: Colors.white,
        title: const Text(
          'Gateways',
          style: TextStyle(fontWeight: FontWeight.w600),
        ),
        actions: [
          // Online/Offline Counter
          if (!_isLoading && !_hasError)
            Center(
              child: Container(
                margin: const EdgeInsets.only(right: 16),
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: Colors.white.withOpacity(0.2),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  '${_countByStatus('online')}/${_gateways.length} Online',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
              ),
            ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _hasError
              ? _buildErrorState()
              : RefreshIndicator(
                  onRefresh: _loadGateways,
                  color: _brandTeal,
                  child: _gateways.isEmpty
                      ? _buildEmptyState()
                      : ListView.builder(
                          padding: const EdgeInsets.only(
                              top: 12, bottom: 100),
                          itemCount: _gateways.length,
                          itemBuilder: (context, index) {
                            final gateway =
                                _gateways[index] as Map<String, dynamic>;
                            return _buildGatewayCard(gateway);
                          },
                        ),
                ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showInstallDialog,
        backgroundColor: _brandTeal,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add),
        label: const Text(
          'Gateway hinzufügen',
          style: TextStyle(fontWeight: FontWeight.w600),
        ),
      ),
    );
  }

  // ─── Card Widget ──────────────────────────────────────────────

  Widget _buildGatewayCard(Map<String, dynamic> gateway) {
    final String name = gateway['name'] as String? ?? 'Gateway';
    final String status = gateway['status'] as String? ?? 'offline';
    final String? host = gateway['host'] as String?;
    final String? lastHeartbeat = gateway['last_heartbeat'] as String?;
    final List<dynamic> capabilities =
        gateway['capabilities'] as List<dynamic>? ?? [];
    final String? version = gateway['version'] as String?;
    final bool isOnline = status == 'online';

    return Card(
      elevation: 2,
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(
          color: isOnline
              ? const Color(0xFF2E7D32).withOpacity(0.2)
              : Colors.red.shade200.withOpacity(0.5),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── Header: Name + Status ──────────────────────────
            Row(
              children: [
                // Status-Indikator (animiert pulsierend für online)
                _buildStatusIndicator(isOnline),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    name,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.bold,
                      color: Colors.black87,
                    ),
                  ),
                ),
                StatusChip(status: status, size: StatusChipSize.medium),
              ],
            ),
            const SizedBox(height: 10),

            // ── Host (gekürzt) ─────────────────────────────────
            if (host != null) ...[
              Row(
                children: [
                  Icon(Icons.dns_outlined,
                      size: 14, color: Colors.grey.shade500),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      _truncateHost(host),
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.grey.shade600,
                        fontFamily: 'monospace',
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
            ],

            // ── Letzter Heartbeat ──────────────────────────────
            Row(
              children: [
                Icon(Icons.access_time_outlined,
                    size: 14, color: Colors.grey.shade500),
                const SizedBox(width: 6),
                Text(
                  'Zuletzt aktiv: ${_formatHeartbeat(lastHeartbeat)}',
                  style: TextStyle(
                    fontSize: 12,
                    color: isOnline
                        ? const Color(0xFF2E7D32)
                        : Colors.grey.shade600,
                  ),
                ),
                if (version != null) ...[
                  const Spacer(),
                  Text(
                    'v$version',
                    style: TextStyle(
                      fontSize: 11,
                      color: Colors.grey.shade400,
                    ),
                  ),
                ],
              ],
            ),

            // ── Capabilities ───────────────────────────────────
            if (capabilities.isNotEmpty) ...[
              const SizedBox(height: 10),
              Divider(height: 1, color: Colors.grey.shade200),
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: capabilities.take(6).map((cap) {
                  return Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: _brandTeal.withOpacity(0.08),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(
                          color: _brandTeal.withOpacity(0.2)),
                    ),
                    child: Text(
                      cap.toString(),
                      style: TextStyle(
                        fontSize: 11,
                        color: _brandTeal.withOpacity(0.9),
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  );
                }).toList(),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildStatusIndicator(bool isOnline) {
    return Container(
      width: 12,
      height: 12,
      decoration: BoxDecoration(
        color: isOnline
            ? const Color(0xFF4CAF50)
            : Colors.red.shade400,
        shape: BoxShape.circle,
        boxShadow: isOnline
            ? [
                BoxShadow(
                  color: const Color(0xFF4CAF50).withOpacity(0.4),
                  blurRadius: 6,
                  spreadRadius: 1,
                ),
              ]
            : null,
      ),
    );
  }

  // ─── Install-Dialog ───────────────────────────────────────────

  void _showInstallDialog() {
    // TODO: Ersetze REGISTRATION_TOKEN mit dem tatsächlichen Token
    const installCommand =
        'pip install realsync-gateway\nrealsync-gateway start --token YOUR_REGISTRATION_TOKEN';

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.75,
        minChildSize: 0.4,
        maxChildSize: 0.95,
        expand: false,
        builder: (ctx, controller) => SingleChildScrollView(
          controller: controller,
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Handle-Bar
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: Colors.grey.shade300,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 20),
              const Text(
                'Gateway installieren',
                style: TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.bold,
                  color: Colors.black87,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Ein Gateway verbindet deine lokale Infrastruktur mit dem Agent-OS.',
                style: TextStyle(color: Colors.grey.shade600),
              ),
              const SizedBox(height: 24),

              _buildInstallStep(
                step: 1,
                title: 'Voraussetzungen',
                content:
                    '• Python 3.10 oder höher\n• pip (Python Package Manager)\n• Netzwerkzugang zum Internet',
              ),
              const SizedBox(height: 16),
              _buildInstallStep(
                step: 2,
                title: 'Gateway installieren & starten',
                content: installCommand,
                isCode: true,
                onCopy: () {
                  Clipboard.setData(
                      const ClipboardData(text: installCommand));
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Befehl kopiert!')),
                  );
                },
              ),
              const SizedBox(height: 16),
              _buildInstallStep(
                step: 3,
                title: 'Token generieren',
                content:
                    'Registrierungs-Tokens werden in den Einstellungen → API & Gateways generiert.',
              ),
              const SizedBox(height: 16),
              _buildInstallStep(
                step: 4,
                title: 'Verbindung prüfen',
                content:
                    'Nach dem Start erscheint das Gateway hier in der Liste. Warte bis es "Online" zeigt.',
              ),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () => Navigator.pop(ctx),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: _brandTeal,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                  ),
                  child: const Text('Fertig'),
                ),
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildInstallStep({
    required int step,
    required String title,
    required String content,
    bool isCode = false,
    VoidCallback? onCopy,
  }) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: isCode ? const Color(0xFF1A1A2E) : Colors.grey.shade50,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: isCode ? Colors.transparent : Colors.grey.shade200,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 24,
                height: 24,
                decoration: BoxDecoration(
                  color: _brandTeal,
                  shape: BoxShape.circle,
                ),
                child: Center(
                  child: Text(
                    '$step',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 12,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                title,
                style: TextStyle(
                  fontWeight: FontWeight.w600,
                  color: isCode ? Colors.white : Colors.black87,
                ),
              ),
              if (onCopy != null) ...[
                const Spacer(),
                IconButton(
                  onPressed: onCopy,
                  icon: const Icon(Icons.copy, color: Colors.grey, size: 18),
                  tooltip: 'Kopieren',
                  constraints: const BoxConstraints(),
                  padding: EdgeInsets.zero,
                ),
              ],
            ],
          ),
          const SizedBox(height: 8),
          Text(
            content,
            style: TextStyle(
              fontSize: 13,
              color: isCode ? Colors.greenAccent.shade200 : Colors.grey.shade700,
              fontFamily: isCode ? 'monospace' : null,
              height: 1.6,
            ),
          ),
        ],
      ),
    );
  }

  // ─── Empty / Error States ────────────────────────────────────

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.router_outlined, size: 72, color: Colors.grey.shade400),
          const SizedBox(height: 16),
          Text(
            'Keine Gateways registriert',
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              color: Colors.grey.shade600,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Füge dein erstes Gateway über den + Button hinzu.',
            style: TextStyle(color: Colors.grey.shade500),
            textAlign: TextAlign.center,
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
          Icon(Icons.cloud_off, size: 64, color: Colors.grey.shade400),
          const SizedBox(height: 16),
          const Text('Fehler beim Laden',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          Text(_errorMessage, textAlign: TextAlign.center),
          const SizedBox(height: 24),
          ElevatedButton.icon(
            onPressed: _loadGateways,
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

  // ─── Helper Methods ───────────────────────────────────────────

  int _countByStatus(String status) {
    return _gateways.where((g) => (g as Map)['status'] == status).length;
  }

  String _truncateHost(String host) {
    if (host.length <= 40) return host;
    return '${host.substring(0, 18)}...${host.substring(host.length - 18)}';
  }

  String _formatHeartbeat(String? isoString) {
    if (isoString == null || isoString.isEmpty) return 'Unbekannt';
    try {
      final dt = DateTime.parse(isoString).toLocal();
      final now = DateTime.now();
      final diff = now.difference(dt);

      if (diff.inSeconds < 30) return 'Gerade eben';
      if (diff.inMinutes < 1) return 'vor ${diff.inSeconds} Sek.';
      if (diff.inMinutes < 60) return 'vor ${diff.inMinutes} Min.';
      if (diff.inHours < 24) return 'vor ${diff.inHours} Std.';
      return DateFormat('dd.MM.yy HH:mm').format(dt);
    } catch (_) {
      return 'Unbekannt';
    }
  }
}
