module.exports = {
  apps: [{
    name: 'beauty-os',
    script: 'server/index.js',
    instances: 1,
    autorestart: true,
    watch: ['server'],
    watch_delay: 1000,
    ignore_watch: ['node_modules', 'logs'],
    max_memory_restart: '512M',
    env: { NODE_ENV: 'production', PORT: 3000 },
    error_file: './logs/error.log',
    out_file:   './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    time: true
  }]
};
