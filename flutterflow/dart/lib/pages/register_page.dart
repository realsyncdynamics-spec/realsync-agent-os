import 'package:flutter/material.dart';
import '../services/api_service.dart';
import 'dashboard_page.dart';

class RegisterPage extends StatefulWidget {
  const RegisterPage({super.key});

  @override
  State<RegisterPage> createState() => _RegisterPageState();
}

class _RegisterPageState extends State<RegisterPage> {
  final _formKey     = GlobalKey<FormState>();
  final _nameCtrl    = TextEditingController();
  final _emailCtrl   = TextEditingController();
  final _pwCtrl      = TextEditingController();
  final _pw2Ctrl     = TextEditingController();
  final _tenantCtrl  = TextEditingController();

  bool _loading   = false;
  bool _obscurePw = true;
  String? _error;

  static const _teal     = Color(0xFF01696F);
  static const _tealDark = Color(0xFF0C4E54);

  @override
  void dispose() {
    _nameCtrl.dispose();
    _emailCtrl.dispose();
    _pwCtrl.dispose();
    _pw2Ctrl.dispose();
    _tenantCtrl.dispose();
    super.dispose();
  }

  Future<void> _register() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() { _loading = true; _error = null; });

    try {
      await ApiService.instance.register(
        tenantName:  _tenantCtrl.text.trim(),
        name:        _nameCtrl.text.trim(),
        email:       _emailCtrl.text.trim(),
        password:    _pwCtrl.text,
      );
      if (!mounted) return;
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(builder: (_) => const DashboardPage()),
      );
    } on ApiException catch (e) {
      setState(() { _error = e.message; });
    } finally {
      if (mounted) setState(() { _loading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.grey[50],
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              children: [
                // Logo
                Container(
                  width: 64, height: 64,
                  decoration: BoxDecoration(
                    color: _teal,
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: const Icon(Icons.smart_toy_outlined, color: Colors.white, size: 36),
                ),
                const SizedBox(height: 24),
                Text(
                  'Konto erstellen',
                  style: TextStyle(
                    fontSize: 26, fontWeight: FontWeight.w700, color: _tealDark,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Starte dein 14-Tage Free Trial',
                  style: TextStyle(fontSize: 14, color: Colors.grey[600]),
                ),
                const SizedBox(height: 32),

                Card(
                  elevation: 2,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  child: Padding(
                    padding: const EdgeInsets.all(28),
                    child: Form(
                      key: _formKey,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          // Error banner
                          if (_error != null) ...[
                            Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: Colors.red[50],
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(color: Colors.red[200]!),
                              ),
                              child: Text(_error!, style: TextStyle(color: Colors.red[800], fontSize: 13)),
                            ),
                            const SizedBox(height: 16),
                          ],

                          // Company name
                          TextFormField(
                            controller: _tenantCtrl,
                            textInputAction: TextInputAction.next,
                            decoration: _inputDeco('Unternehmensname', Icons.business_outlined),
                            validator: (v) => (v == null || v.trim().isEmpty) ? 'Unternehmensname erforderlich' : null,
                          ),
                          const SizedBox(height: 16),

                          // Full name
                          TextFormField(
                            controller: _nameCtrl,
                            textInputAction: TextInputAction.next,
                            decoration: _inputDeco('Vollständiger Name', Icons.person_outline),
                            validator: (v) => (v == null || v.trim().isEmpty) ? 'Name erforderlich' : null,
                          ),
                          const SizedBox(height: 16),

                          // Email
                          TextFormField(
                            controller: _emailCtrl,
                            keyboardType: TextInputType.emailAddress,
                            textInputAction: TextInputAction.next,
                            decoration: _inputDeco('E-Mail-Adresse', Icons.email_outlined),
                            validator: (v) {
                              if (v == null || v.trim().isEmpty) return 'E-Mail erforderlich';
                              if (!RegExp(r'^[^@]+@[^@]+\.[^@]+$').hasMatch(v.trim())) return 'Ungültige E-Mail';
                              return null;
                            },
                          ),
                          const SizedBox(height: 16),

                          // Password
                          TextFormField(
                            controller: _pwCtrl,
                            obscureText: _obscurePw,
                            textInputAction: TextInputAction.next,
                            decoration: _inputDeco('Passwort', Icons.lock_outline).copyWith(
                              suffixIcon: IconButton(
                                icon: Icon(_obscurePw ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                                onPressed: () => setState(() { _obscurePw = !_obscurePw; }),
                              ),
                            ),
                            validator: (v) {
                              if (v == null || v.isEmpty) return 'Passwort erforderlich';
                              if (v.length < 8) return 'Mindestens 8 Zeichen';
                              if (!RegExp(r'[A-Z]').hasMatch(v)) return 'Mindestens 1 Großbuchstabe';
                              if (!RegExp(r'[0-9]').hasMatch(v)) return 'Mindestens 1 Ziffer';
                              return null;
                            },
                          ),
                          const SizedBox(height: 16),

                          // Confirm password
                          TextFormField(
                            controller: _pw2Ctrl,
                            obscureText: _obscurePw,
                            textInputAction: TextInputAction.done,
                            onFieldSubmitted: (_) => _register(),
                            decoration: _inputDeco('Passwort bestätigen', Icons.lock_outline),
                            validator: (v) {
                              if (v == null || v.isEmpty) return 'Passwortbestätigung erforderlich';
                              if (v != _pwCtrl.text) return 'Passwörter stimmen nicht überein';
                              return null;
                            },
                          ),
                          const SizedBox(height: 24),

                          // Register button
                          SizedBox(
                            height: 50,
                            child: ElevatedButton(
                              onPressed: _loading ? null : _register,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: _teal,
                                foregroundColor: Colors.white,
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                                elevation: 0,
                              ),
                              child: _loading
                                  ? const SizedBox(
                                      width: 20, height: 20,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2, color: Colors.white,
                                      ),
                                    )
                                  : const Text(
                                      'Kostenlos registrieren',
                                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                                    ),
                            ),
                          ),

                          const SizedBox(height: 16),
                          Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text('Bereits registriert? ',
                                style: TextStyle(color: Colors.grey[600], fontSize: 14)),
                              GestureDetector(
                                onTap: () => Navigator.pop(context),
                                child: Text(
                                  'Anmelden',
                                  style: TextStyle(
                                    color: _teal,
                                    fontSize: 14,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ),

                const SizedBox(height: 24),
                Text(
                  'Mit der Registrierung stimmst du den AGB und der\nDatenschutzerklärung (DSGVO-konform) zu.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 11, color: Colors.grey[500]),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  InputDecoration _inputDeco(String label, IconData icon) => InputDecoration(
    labelText: label,
    prefixIcon: Icon(icon, size: 20),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: const BorderSide(color: _teal, width: 2),
    ),
    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
  );
}
