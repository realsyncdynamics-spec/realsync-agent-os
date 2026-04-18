// ============================================================
// workflow_card.dart
// RealSyncDynamics Agent-OS — WorkflowCard Widget
//
// Verwendung:
//   WorkflowCard(
//     workflow: workflowMap,
//     onTap: () => Navigator.pushNamed(context, '/workflows/${id}'),
//   )
//
// Erwartet workflow Map mit Keys:
//   id, name, status, goal, last_run_at, agents, risk_level
// ============================================================

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'status_chip.dart';

class WorkflowCard extends StatelessWidget {
  final Map<String, dynamic> workflow;
  final VoidCallback? onTap;

  const WorkflowCard({
    super.key,
    required this.workflow,
    this.onTap,
  });

  // ─── Build ───────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final String name = workflow['name'] as String? ?? 'Unbenannter Workflow';
    final String status = workflow['status'] as String? ?? 'draft';
    final String goal = workflow['goal'] as String? ?? '';
    final String? lastRunAt = workflow['last_run_at'] as String?;
    final List<dynamic> agents = workflow['agents'] as List<dynamic>? ?? [];
    final String? riskLevel = workflow['risk_level'] as String?;

    // Goal auf 80 Zeichen kürzen
    final String goalDisplay =
        goal.length > 80 ? '${goal.substring(0, 77)}...' : goal;

    return Card(
      elevation: 2,
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: Colors.grey.shade200),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // ── Header: Titel + Status-Chip ─────────────────
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(
                      name,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        color: Colors.black87,
                        height: 1.3,
                      ),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 10),
                  StatusChip(status: status, size: StatusChipSize.medium),
                ],
              ),
              const SizedBox(height: 8),

              // ── Goal (gekürzt) ───────────────────────────────
              if (goalDisplay.isNotEmpty) ...[
                Text(
                  goalDisplay,
                  style: TextStyle(
                    fontSize: 13,
                    color: Colors.grey.shade600,
                    height: 1.4,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 12),
              ],

              // ── Divider ──────────────────────────────────────
              Divider(height: 1, color: Colors.grey.shade200),
              const SizedBox(height: 10),

              // ── Footer: Letzter Run + Agents ─────────────────
              Row(
                children: [
                  // Letzter Run
                  Icon(
                    Icons.access_time_outlined,
                    size: 14,
                    color: Colors.grey.shade500,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    _formatLastRun(lastRunAt),
                    style: TextStyle(
                      fontSize: 12,
                      color: Colors.grey.shade500,
                    ),
                  ),
                  const Spacer(),

                  // Agent-Type Chips
                  if (agents.isNotEmpty)
                    _buildAgentChips(agents),

                  // Risk-Badge (wenn vorhanden)
                  if (riskLevel != null && riskLevel.isNotEmpty) ...[
                    const SizedBox(width: 6),
                    StatusChip(
                      status: riskLevel,
                      size: StatusChipSize.small,
                    ),
                  ],
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ─── Helper Widgets ──────────────────────────────────────────

  Widget _buildAgentChips(List<dynamic> agents) {
    // Zeige max. 3 Agent-Typen als kleine farbige Chips
    final uniqueTypes = <String>{};
    for (final agent in agents) {
      if (agent is Map<String, dynamic>) {
        final type = agent['type'] as String? ?? 'agent';
        uniqueTypes.add(type);
      }
    }

    final displayTypes = uniqueTypes.take(3).toList();

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: displayTypes
          .map((type) => Container(
                margin: const EdgeInsets.only(left: 4),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: _agentTypeColor(type).withOpacity(0.1),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(
                    color: _agentTypeColor(type).withOpacity(0.3),
                    width: 1,
                  ),
                ),
                child: Text(
                  _agentTypeLabel(type),
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                    color: _agentTypeColor(type),
                  ),
                ),
              ))
          .toList(),
    );
  }

  // ─── Helper Methods ──────────────────────────────────────────

  String _formatLastRun(String? isoString) {
    if (isoString == null || isoString.isEmpty) return 'Noch nie';
    try {
      final dt = DateTime.parse(isoString).toLocal();
      final now = DateTime.now();
      final diff = now.difference(dt);

      if (diff.inMinutes < 1) return 'Gerade eben';
      if (diff.inMinutes < 60) return 'vor ${diff.inMinutes} Min.';
      if (diff.inHours < 24) return 'vor ${diff.inHours} Std.';
      if (diff.inDays < 7) return 'vor ${diff.inDays} Tag(en)';
      return DateFormat('dd.MM.yyyy').format(dt);
    } catch (_) {
      return 'Unbekannt';
    }
  }

  Color _agentTypeColor(String type) {
    switch (type.toLowerCase()) {
      case 'research':
        return const Color(0xFF1565C0);
      case 'writer':
        return const Color(0xFF6A1B9A);
      case 'code':
      case 'coder':
        return const Color(0xFF00695C);
      case 'analyst':
        return const Color(0xFFE65100);
      case 'coordinator':
        return const Color(0xFF4A148C);
      default:
        return const Color(0xFF424242);
    }
  }

  String _agentTypeLabel(String type) {
    switch (type.toLowerCase()) {
      case 'research':
        return 'Research';
      case 'writer':
        return 'Writer';
      case 'code':
      case 'coder':
        return 'Code';
      case 'analyst':
        return 'Analyst';
      case 'coordinator':
        return 'Coord.';
      default:
        return type.length > 8 ? type.substring(0, 7) : type;
    }
  }
}
