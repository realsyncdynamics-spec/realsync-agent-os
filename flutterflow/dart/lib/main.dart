// ============================================================
// main.dart
// RealSyncDynamics Agent-OS — Flutter Entry Point
//
// FlutterFlow-Hinweis:
//   - MaterialApp mit Named Routes
//   - Theme: ColorScheme aus #01696F (Teal)
//   - Startup-Check: Wenn Token vorhanden → /dashboard, sonst /login
//   - SplashScreen mit Logo + Ladeanimation
//
// Routing-Übersicht:
//   '/'              → SplashScreen (Token-Check)
//   '/login'         → LoginPage
//   '/register'      → RegisterPage
//   '/dashboard'     → DashboardPage
//   '/workflows'     → WorkflowsPage
//   '/gateways'      → GatewaysPage
//   '/compliance'    → CompliancePage (Platzhalter)
// ============================================================

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'services/api_service.dart';
import 'pages/login_page.dart';
import 'pages/register_page.dart';
import 'pages/dashboard_page.dart';
import 'pages/workflows_page.dart';
import 'pages/workflow_detail_page.dart';
import 'pages/gateways_page.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Status-Bar-Style (helle Icons für dunklen Hintergrund)
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
    ),
  );

  // Nur Portrait-Modus (optional, entfernen für Landscape-Unterstützung)
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  runApp(const RealSyncApp());
}

class RealSyncApp extends StatelessWidget {
  const RealSyncApp({super.key});

  // ─── Brand Color ─────────────────────────────────────────────
  static const Color _brandTeal = Color(0xFF01696F);

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'RealSync Agent-OS',
      debugShowCheckedModeBanner: false,

      // ── Theme ─────────────────────────────────────────────────
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: _brandTeal,
          brightness: Brightness.light,
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: _brandTeal,
          foregroundColor: Colors.white,
          elevation: 0,
          centerTitle: false,
          titleTextStyle: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: Colors.white,
          ),
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: _brandTeal,
            foregroundColor: Colors.white,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            ),
            padding:
                const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          ),
        ),
        cardTheme: CardTheme(
          elevation: 2,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
        ),
        inputDecorationTheme: InputDecorationTheme(
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: _brandTeal, width: 2),
          ),
        ),
        floatingActionButtonTheme: const FloatingActionButtonThemeData(
          backgroundColor: _brandTeal,
          foregroundColor: Colors.white,
        ),
        bottomNavigationBarTheme: const BottomNavigationBarThemeData(
          selectedItemColor: _brandTeal,
          unselectedItemColor: Colors.grey,
          type: BottomNavigationBarType.fixed,
          elevation: 8,
        ),
        fontFamily: 'Roboto',
      ),

      // Dunkles Theme (optional)
      darkTheme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: _brandTeal,
          brightness: Brightness.dark,
        ),
        appBarTheme: AppBarTheme(
          backgroundColor: Colors.grey.shade900,
          foregroundColor: Colors.white,
        ),
      ),
      themeMode: ThemeMode.light, // TODO: ThemeMode.system für Auto

      // ── Routing ───────────────────────────────────────────────
      initialRoute: '/',
      onGenerateRoute: (settings) {
        // Dynamisches Routing für Workflow-Detail mit ID
        final uri = Uri.parse(settings.name ?? '/');

        // /workflows/:id
        if (uri.pathSegments.length == 2 &&
            uri.pathSegments[0] == 'workflows' &&
            uri.pathSegments[1] != 'create') {
          final workflowId = uri.pathSegments[1];
          return MaterialPageRoute(
            settings: settings,
            builder: (_) => WorkflowDetailPage(workflowId: workflowId),
          );
        }

        // Standard-Routen
        return MaterialPageRoute(
          settings: settings,
          builder: (context) => _buildPage(settings.name ?? '/'),
        );
      },
    );
  }

  Widget _buildPage(String route) {
    switch (route) {
      case '/':
        return const SplashScreen();
      case '/login':
        return const LoginPage();
      case '/register':
        return const RegisterPage();
      case '/dashboard':
        return const DashboardPage();
      case '/workflows':
        return const WorkflowsPage();
      case '/gateways':
        return const GatewaysPage();
      case '/compliance':
        return const CompliancePlaceholderPage();
      default:
        return const _NotFoundPage();
    }
  }
}

// ============================================================
// SplashScreen — Token-Check und Redirect
// ============================================================

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with SingleTickerProviderStateMixin {
  late AnimationController _animController;
  late Animation<double> _fadeAnim;
  late Animation<double> _scaleAnim;

  static const Color _brandTeal = Color(0xFF01696F);

  @override
  void initState() {
    super.initState();

    _animController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    );

    _fadeAnim = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(parent: _animController, curve: Curves.easeOut),
    );

    _scaleAnim = Tween<double>(begin: 0.7, end: 1.0).animate(
      CurvedAnimation(parent: _animController, curve: Curves.elasticOut),
    );

    _animController.forward();

    // Nach Animation: Token prüfen und weiterleiten
    Future.delayed(const Duration(milliseconds: 1800), _checkAuth);
  }

  @override
  void dispose() {
    _animController.dispose();
    super.dispose();
  }

  Future<void> _checkAuth() async {
    final token = await ApiService.getToken();
    if (!mounted) return;

    if (token != null && token.isNotEmpty) {
      // Token vorhanden → Zur Dashboard-Seite
      final isHealthy = await ApiService.checkHealth();
      if (!mounted) return;

      if (isHealthy) {
        Navigator.pushReplacementNamed(context, '/dashboard');
      } else {
        // Backend nicht erreichbar → Trotzdem versuchen zu laden
        Navigator.pushReplacementNamed(context, '/dashboard');
      }
    } else {
      // Kein Token → Login
      Navigator.pushReplacementNamed(context, '/login');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _brandTeal,
      body: Center(
        child: AnimatedBuilder(
          animation: _animController,
          builder: (context, child) {
            return FadeTransition(
              opacity: _fadeAnim,
              child: ScaleTransition(
                scale: _scaleAnim,
                child: child,
              ),
            );
          },
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              // Logo
              Container(
                width: 100,
                height: 100,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(28),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withOpacity(0.2),
                      blurRadius: 24,
                      offset: const Offset(0, 8),
                    ),
                  ],
                ),
                child: const Center(
                  child: Text(
                    'RS',
                    style: TextStyle(
                      color: _brandTeal,
                      fontSize: 40,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 1,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 24),

              // Brand-Name
              const Text(
                'RealSync',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 32,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 1.5,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Agent Operating System',
                style: TextStyle(
                  color: Colors.white.withOpacity(0.7),
                  fontSize: 14,
                  letterSpacing: 2,
                ),
              ),
              const SizedBox(height: 60),

              // Lade-Indicator
              SizedBox(
                width: 32,
                height: 32,
                child: CircularProgressIndicator(
                  strokeWidth: 2.5,
                  color: Colors.white.withOpacity(0.6),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ============================================================
// CompliancePlaceholderPage — Platzhalter für Compliance-Seite
// FlutterFlow-Hinweis: Ersetze dies mit der echten Compliance-Page
// ============================================================

class CompliancePlaceholderPage extends StatelessWidget {
  const CompliancePlaceholderPage({super.key});

  static const Color _brandTeal = Color(0xFF01696F);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Compliance'),
        backgroundColor: _brandTeal,
        foregroundColor: Colors.white,
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.verified_outlined,
                size: 72, color: Colors.grey.shade400),
            const SizedBox(height: 16),
            Text(
              'Compliance-Reports',
              style: TextStyle(
                fontSize: 22,
                fontWeight: FontWeight.bold,
                color: Colors.grey.shade700,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Diese Seite wird in Sprint 4 implementiert.',
              style: TextStyle(color: Colors.grey.shade500),
            ),
          ],
        ),
      ),
    );
  }
}

// ============================================================
// _NotFoundPage — 404 Fallback
// ============================================================

class _NotFoundPage extends StatelessWidget {
  const _NotFoundPage();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Nicht gefunden')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text('404', style: TextStyle(fontSize: 64)),
            const Text('Seite nicht gefunden'),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: () =>
                  Navigator.pushReplacementNamed(context, '/dashboard'),
              child: const Text('Zum Dashboard'),
            ),
          ],
        ),
      ),
    );
  }
}
