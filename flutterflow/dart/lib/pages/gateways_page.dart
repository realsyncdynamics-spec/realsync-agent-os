import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../widgets/status_chip.dart';

class GatewaysPage extends StatefulWidget {
  const GatewaysPage({super.key});

  @override
  State<GatewaysPage> createState() => _GatewaysPageState();
}

class _GatewaysPageState extends State<GatewaysPage> {
  static const _teal     = Color(0xFF01696F);
  static const _tealDark = Color(0xFF0C4E54);

  List<dynamic> _gateways = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final data = await ApiService.instance.getGateways();
      setState(() { _gateways = data; });
    } on ApiException catch (e) {
      setState(() { _error = e.message; });
    } finally {
      if (mounted) setState(() { _loading = false; });
    }
  }

  Future<void> _showAddGatewaySheet() async {
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => _AddGatewaySheet(onCreated: _load),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.grey[50],
      appBar: AppBar(
        backgroundColor: _tealDark,
        foregroundColor: Colors.white,
        title: const Text('OpenClaw Gateways'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showAddGatewaySheet,
        backgroundColor: _teal,
        icon: const Icon(Icons.add, color: Colors.white),
        label: const Text('Gateway hinzufügen', style: TextStyle(color: Colors.white)),
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator(color: _teal));
    if (_error != null) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.error_outline, size: 48, color: Colors.red[400]),
          const SizedBox(height: 12),
          Text(_error!, style: TextStyle(color: Colors.red[700])),
          const SizedBox(height: 16),
          ElevatedButton(onPressed: _load, child: const Text('Erneut versuchen')),
        ]),
      );
    }
    if (_gateways.isEmpty) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.hub_outlined, size: 64, color: Colors.grey[400]),
          const SizedBox(height: 16),
          Text('Noch keine Gateways registriert',
            style: TextStyle(fontSize: 16, color: Colors.grey[600])),
          const SizedBox(height: 8),
          Text('Verbinde dein erstes OpenClaw-Gateway',
            style: TextStyle(color: Colors.grey[500])),
        ]),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      color: _teal,
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 100),
        itemCount: _gateways.length,
        itemBuilder: (_, i) => _GatewayCard(gateway: _gateways[i], onRefresh: _load),
      ),
    );
  }
}

class _GatewayCard extends StatelessWidget {
  final Map<String, dynamic> gateway;
  final VoidCallback onRefresh;
  const _GatewayCard({required this.gateway, required this.onRefresh});

  static const _teal     = Color(0xFF01696F);
  static const _tealDark = Color(0xFF0C4E54);

  @override
  Widget build(BuildContext context) {
    final status = gateway['status'] ?? 'unknown';
    final online = status == 'active' || status == 'online';

    return Card(
      elevation: 2,
      margin: const EdgeInsets.only(bottom: 12),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 44, height: 44,
                  decoration: BoxDecoration(
                    color: online ? _teal.withOpacity(0.1) : Colors.grey[200],
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(
                    Icons.hub_outlined,
                    color: online ? _teal : Colors.grey,
                    size: 24,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(gateway['name'] ?? 'Unnamed Gateway',
                        style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15, color: _tealDark)),
                      Text(gateway['endpoint'] ?? '-',
                        style: TextStyle(color: Colors.grey[600], fontSize: 12),
                        overflow: TextOverflow.ellipsis),
                    ],
                  ),
                ),
                StatusChip(status: status),
              ],
            ),
            const Divider(height: 20),
            Row(
              children: [
                _statTile('Typ', gateway['type'] ?? '-'),
                _statTile('Region', gateway['region'] ?? 'europe-west1'),
                _statTile('Version', gateway['version'] ?? '-'),
              ],
            ),
            if (gateway['last_ping'] != null) ...[
              const SizedBox(height: 8),
              Text(
                'Letzter Ping: ${_formatDate(gateway['last_ping'])}',
                style: TextStyle(fontSize: 11, color: Colors.grey[500]),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _statTile(String label, String value) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 11, color: Colors.grey)),
          Text(value,
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
            overflow: TextOverflow.ellipsis),
        ],
      ),
    );
  }

  String _formatDate(dynamic value) {
    if (value == null) return '-';
    try {
      final dt = DateTime.parse(value.toString()).toLocal();
      return '${dt.day.toString().padLeft(2,'0')}.${dt.month.toString().padLeft(2,'0')}.${dt.year} ${dt.hour.toString().padLeft(2,'0')}:${dt.minute.toString().padLeft(2,'0')}';
    } catch (_) { return value.toString(); }
  }
}

class _AddGatewaySheet extends StatefulWidget {
  final VoidCallback onCreated;
  const _AddGatewaySheet({required this.onCreated});

  @override
  State<_AddGatewaySheet> createState() => _AddGatewaySheetState();
}

class _AddGatewaySheetState extends State<_AddGatewaySheet> {
  final _formKey      = GlobalKey<FormState>();
  final _nameCtrl     = TextEditingController();
  final _endpointCtrl = TextEditingController();
  final _keyCtrl      = TextEditingController();
  String _type        = 'openclaw';
  bool _loading       = false;

  static const _teal = Color(0xFF01696F);

  @override
  void dispose() {
    _nameCtrl.dispose();
    _endpointCtrl.dispose();
    _keyCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() { _loading = true; });
    try {
      await ApiService.instance.createGateway({
        'name':     _nameCtrl.text.trim(),
        'endpoint': _endpointCtrl.text.trim(),
        'api_key':  _keyCtrl.text.trim(),
        'type':     _type,
      });
      widget.onCreated();
      if (mounted) Navigator.pop(context);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() { _loading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 24, right: 24, top: 24,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Form(
        key: _formKey,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Gateway hinzufügen',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 20),
          TextFormField(
            controller: _nameCtrl,
            decoration: const InputDecoration(labelText: 'Name', border: OutlineInputBorder()),
            validator: (v) => (v?.trim().isEmpty ?? true) ? 'Name erforderlich' : null,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _endpointCtrl,
            decoration: const InputDecoration(labelText: 'Endpoint URL', border: OutlineInputBorder()),
            keyboardType: TextInputType.url,
            validator: (v) {
              if (v?.trim().isEmpty ?? true) return 'Endpoint erforderlich';
              if (!Uri.tryParse(v!.trim())!.isAbsolute) return 'Gültige URL erforderlich';
              return null;
            },
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _keyCtrl,
            decoration: const InputDecoration(labelText: 'API-Schlüssel', border: OutlineInputBorder()),
            obscureText: true,
            validator: (v) => (v?.trim().isEmpty ?? true) ? 'API-Schlüssel erforderlich' : null,
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            value: _type,
            decoration: const InputDecoration(labelText: 'Typ', border: OutlineInputBorder()),
            items: const [
              DropdownMenuItem(value: 'openclaw', child: Text('OpenClaw')),
              DropdownMenuItem(value: 'webhook',  child: Text('Webhook')),
              DropdownMenuItem(value: 'grpc',     child: Text('gRPC')),
            ],
            onChanged: (v) => setState(() { _type = v!; }),
          ),
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity, height: 48,
            child: ElevatedButton(
              onPressed: _loading ? null : _submit,
              style: ElevatedButton.styleFrom(
                backgroundColor: _teal, foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              ),
              child: _loading
                ? const SizedBox(width: 20, height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Verbinden', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            ),
          ),
        ]),
      ),
    );
  }
}
