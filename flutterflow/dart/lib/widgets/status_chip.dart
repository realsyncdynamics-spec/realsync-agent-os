// ============================================================
// status_chip.dart
// RealSyncDynamics Agent-OS — Wiederverwendbares Status-Chip
//
// Verwendung:
//   StatusChip(status: 'active')
//   StatusChip(status: 'online', size: StatusChipSize.small)
//
// Unterstützte Status-Werte:
//   Workflow:   active | paused | error | draft | pending_approval | running
//   Risk:       minimal | limited | high | critical
//   Gateway:    online | offline | degraded
// ============================================================

import 'package:flutter/material.dart';

enum StatusChipSize { small, medium, large }

class StatusChip extends StatelessWidget {
  final String status;
  final StatusChipSize size;

  const StatusChip({
    super.key,
    required this.status,
    this.size = StatusChipSize.medium,
  });

  // ─── Status-Konfiguration ────────────────────────────────────

  static Map<String, _StatusConfig> get _configs => {
        // Workflow-Status
        'active': _StatusConfig(
          color: const Color(0xFF2E7D32),
          backgroundColor: const Color(0xFFE8F5E9),
          label: 'Aktiv',
          icon: Icons.play_circle_outline,
        ),
        'running': _StatusConfig(
          color: const Color(0xFF1565C0),
          backgroundColor: const Color(0xFFE3F2FD),
          label: 'Läuft',
          icon: Icons.autorenew,
        ),
        'paused': _StatusConfig(
          color: const Color(0xFFE65100),
          backgroundColor: const Color(0xFFFFF3E0),
          label: 'Pausiert',
          icon: Icons.pause_circle_outline,
        ),
        'error': _StatusConfig(
          color: const Color(0xFFC62828),
          backgroundColor: const Color(0xFFFFEBEE),
          label: 'Fehler',
          icon: Icons.error_outline,
        ),
        'draft': _StatusConfig(
          color: const Color(0xFF616161),
          backgroundColor: const Color(0xFFF5F5F5),
          label: 'Entwurf',
          icon: Icons.edit_outlined,
        ),
        'pending_approval': _StatusConfig(
          color: const Color(0xFF6A1B9A),
          backgroundColor: const Color(0xFFF3E5F5),
          label: 'Wartet',
          icon: Icons.pending_outlined,
        ),
        'completed': _StatusConfig(
          color: const Color(0xFF1B5E20),
          backgroundColor: const Color(0xFFE8F5E9),
          label: 'Abgeschlossen',
          icon: Icons.check_circle_outline,
        ),
        'cancelled': _StatusConfig(
          color: const Color(0xFF424242),
          backgroundColor: const Color(0xFFEEEEEE),
          label: 'Abgebrochen',
          icon: Icons.cancel_outlined,
        ),

        // Risk-Level
        'minimal': _StatusConfig(
          color: const Color(0xFF2E7D32),
          backgroundColor: const Color(0xFFE8F5E9),
          label: 'Minimal',
          icon: Icons.shield_outlined,
        ),
        'limited': _StatusConfig(
          color: const Color(0xFFE65100),
          backgroundColor: const Color(0xFFFFF3E0),
          label: 'Begrenzt',
          icon: Icons.shield_outlined,
        ),
        'high': _StatusConfig(
          color: const Color(0xFFC62828),
          backgroundColor: const Color(0xFFFFEBEE),
          label: 'Hoch',
          icon: Icons.warning_amber_outlined,
        ),
        'critical': _StatusConfig(
          color: const Color(0xFF7F0000),
          backgroundColor: const Color(0xFFFFCDD2),
          label: 'Kritisch',
          icon: Icons.dangerous_outlined,
        ),

        // Gateway-Status
        'online': _StatusConfig(
          color: const Color(0xFF2E7D32),
          backgroundColor: const Color(0xFFE8F5E9),
          label: 'Online',
          icon: Icons.circle,
        ),
        'offline': _StatusConfig(
          color: const Color(0xFFC62828),
          backgroundColor: const Color(0xFFFFEBEE),
          label: 'Offline',
          icon: Icons.circle,
        ),
        'degraded': _StatusConfig(
          color: const Color(0xFFE65100),
          backgroundColor: const Color(0xFFFFF3E0),
          label: 'Eingeschränkt',
          icon: Icons.circle,
        ),
      };

  // ─── Build ───────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final config = _configs[status.toLowerCase()] ??
        _StatusConfig(
          color: const Color(0xFF616161),
          backgroundColor: const Color(0xFFF5F5F5),
          label: status,
          icon: Icons.help_outline,
        );

    // Größen-Konfiguration
    final double fontSize;
    final double iconSize;
    final EdgeInsets padding;

    switch (size) {
      case StatusChipSize.small:
        fontSize = 10;
        iconSize = 10;
        padding = const EdgeInsets.symmetric(horizontal: 6, vertical: 2);
        break;
      case StatusChipSize.large:
        fontSize = 14;
        iconSize = 16;
        padding = const EdgeInsets.symmetric(horizontal: 14, vertical: 6);
        break;
      case StatusChipSize.medium:
      default:
        fontSize = 12;
        iconSize = 12;
        padding = const EdgeInsets.symmetric(horizontal: 10, vertical: 4);
        break;
    }

    // Für Gateway Online/Offline: kleiner Punkt statt Text-Icon
    final bool isGatewayStatus =
        status == 'online' || status == 'offline' || status == 'degraded';

    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: config.backgroundColor,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: config.color.withOpacity(0.3),
          width: 1,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (isGatewayStatus) ...[
            Container(
              width: iconSize,
              height: iconSize,
              decoration: BoxDecoration(
                color: config.color,
                shape: BoxShape.circle,
              ),
            ),
          ] else ...[
            Icon(config.icon, size: iconSize, color: config.color),
          ],
          const SizedBox(width: 4),
          Text(
            config.label,
            style: TextStyle(
              fontSize: fontSize,
              fontWeight: FontWeight.w600,
              color: config.color,
            ),
          ),
        ],
      ),
    );
  }
}

// ─── Interne Konfigurations-Klasse ────────────────────────────

class _StatusConfig {
  final Color color;
  final Color backgroundColor;
  final String label;
  final IconData icon;

  const _StatusConfig({
    required this.color,
    required this.backgroundColor,
    required this.label,
    required this.icon,
  });
}
