const PROJ = '/Users/openclaw-user/.openclaw/workspace/scan-to-ship';

module.exports = {
  apps: [
    {
      name: 'sql-proxy',
      script: `${PROJ}/cloud-sql-proxy`,
      args: `--credentials-file ${PROJ}/gcp-key.json analytics-link-370416:us-central1:fivedaughtersbakery`,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      out_file: `${PROJ}/logs/proxy-out.log`,
      error_file: `${PROJ}/logs/proxy-error.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'scan-to-ship',
      script: './start-server.sh',
      cwd: PROJ,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      out_file: `${PROJ}/logs/out.log`,
      error_file: `${PROJ}/logs/error.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 2000,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      listen_timeout: 8000,
      delay: 4000,
      env: { NODE_ENV: 'production', PORT: 3000 }
    }
  ,
    {
      name: 'sync-forecast',
      script: 'sync_forecast.js',
      cwd: PROJ,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '0 23 * * *',
      watch: false,
      out_file: `${PROJ}/logs/sync-forecast-out.log`,
      error_file: `${PROJ}/logs/sync-forecast-error.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: { NODE_ENV: 'production' }
    }
  ]
};
// Note: append these to the apps array manually if this duplicates
