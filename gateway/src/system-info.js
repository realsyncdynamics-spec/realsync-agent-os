'use strict';

/**
 * OpenClaw Gateway — System Info
 * Collects host metrics via the systeminformation library.
 */

const si = require('systeminformation');
const os = require('os');
const logger = require('./logger');

/**
 * Safely rounds a number to a given number of decimal places.
 * Returns 0 on NaN / null / undefined.
 */
function round(val, decimals = 2) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : parseFloat(n.toFixed(decimals));
}

/** Convert bytes → gigabytes */
function toGB(bytes) {
  return round(bytes / (1024 ** 3));
}

/**
 * Fetch comprehensive system information.
 *
 * @returns {Promise<SystemInfo>}
 */
async function getInfo() {
  try {
    const [
      cpuData,
      memData,
      osData,
      diskData,
      networkData,
      loadData,
      timeData,
    ] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.osInfo(),
      si.fsSize(),
      si.networkInterfaces(),
      si.currentLoad(),
      si.time(),
    ]);

    // Aggregate disk stats (sum all physical drives, exclude tmpfs etc.)
    const physicalDisks = diskData.filter(
      (d) => d.type !== 'squashfs' && !d.fs.startsWith('tmpfs') && d.size > 0
    );
    const diskTotal = physicalDisks.reduce((acc, d) => acc + d.size, 0);
    const diskUsed = physicalDisks.reduce((acc, d) => acc + d.used, 0);

    // Network interfaces — filter loopback
    const interfaces = (Array.isArray(networkData) ? networkData : [networkData])
      .filter((iface) => iface && !iface.internal)
      .map((iface) => ({
        name: iface.iface || iface.ifaceName || 'unknown',
        ip4: iface.ip4 || null,
        ip6: iface.ip6 || null,
        mac: iface.mac || null,
        speed_mbps: iface.speed || null,
        type: iface.type || null,
      }));

    return {
      hostname: os.hostname(),
      platform: osData.platform || os.platform(),
      os_version: `${osData.distro || osData.platform} ${osData.release || ''}`.trim(),
      kernel: osData.kernel || null,
      arch: osData.arch || os.arch(),
      cpu_brand: cpuData.brand || cpuData.manufacturer || 'Unknown CPU',
      cpu_count: cpuData.physicalCores || cpuData.cores || os.cpus().length,
      cpu_logical_cores: cpuData.cores || os.cpus().length,
      cpu_speed_ghz: round(cpuData.speed, 2),
      ram_total_gb: toGB(memData.total),
      ram_used_gb: toGB(memData.active || memData.used),
      ram_free_gb: toGB(memData.available || memData.free),
      swap_total_gb: toGB(memData.swaptotal),
      swap_used_gb: toGB(memData.swapused),
      disk_total_gb: toGB(diskTotal),
      disk_used_gb: toGB(diskUsed),
      disk_free_gb: toGB(diskTotal - diskUsed),
      uptime_s: Math.floor(timeData.uptime || os.uptime()),
      load_avg_1m: round(loadData.avgLoad || (os.loadavg()[0] ?? 0), 2),
      load_avg_5m: round(os.loadavg()[1] ?? 0, 2),
      load_avg_15m: round(os.loadavg()[2] ?? 0, 2),
      cpu_usage_pct: round(loadData.currentLoad, 1),
      network_interfaces: interfaces,
      collected_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.error(`system-info: collection error — ${err.message}`);
    // Return a minimal degraded response so the endpoint still works
    return {
      hostname: os.hostname(),
      platform: os.platform(),
      os_version: `${os.platform()} ${os.release()}`,
      kernel: null,
      arch: os.arch(),
      cpu_brand: (os.cpus()[0] || {}).model || 'Unknown',
      cpu_count: os.cpus().length,
      cpu_logical_cores: os.cpus().length,
      cpu_speed_ghz: null,
      ram_total_gb: toGB(os.totalmem()),
      ram_used_gb: toGB(os.totalmem() - os.freemem()),
      ram_free_gb: toGB(os.freemem()),
      swap_total_gb: 0,
      swap_used_gb: 0,
      disk_total_gb: 0,
      disk_used_gb: 0,
      disk_free_gb: 0,
      uptime_s: Math.floor(os.uptime()),
      load_avg_1m: round(os.loadavg()[0] ?? 0, 2),
      load_avg_5m: round(os.loadavg()[1] ?? 0, 2),
      load_avg_15m: round(os.loadavg()[2] ?? 0, 2),
      cpu_usage_pct: null,
      network_interfaces: [],
      collected_at: new Date().toISOString(),
      degraded: true,
      error: err.message,
    };
  }
}

module.exports = { getInfo };
