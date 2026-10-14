// Explicit frontend-only additions shared by the demo and the production portal.
// Keep static asset registration separate from every API and execution route.
export const STARBASE_ASSETS = Object.fromEntries([
  'starbase-tokens.css', 'starbase-shell.css', 'starbase-controls.css', 'starbase-status.css', 'starbase-surfaces.css', 'starbase-overlays.css', 'starbase-responsive.css', 'starbase-motion.css', 'starbase-navigation-glass.css', 'starbase-control-room.css',
  'announcement-ui.js','announcement-appearance.js','announcements.css',
  'fonts.css', 'starbase.css', 'shell.css', 'workbench.css', 'terminal.css', 'resources.css', 'apple-touch-icon.png', 'members.css', 'copy-help.css',
  'shell-ui.js', 'control-ui.js', 'attention-state.js', 'workbench-ui.js', 'training-storage-ui.js', 'motion-ui.js', 'copy-help-ui.js', 'auth-ui.js', 'navigation.js', 'toast-ui.js',
  'favicon.svg', 'favicon.ico', 'mask-icon.svg', 'campus-ticket-time.js',
  'task-display-ui.js',
  'job-results-ui.js', 'time-format.js', 'trash-ui.js', 'file-transfer-ui.js',
  'maintenance-state.js', 'maintenance-experience.js', 'maintenance-experience.css',
  'admin-ui.js', 'admin.css', 'admin-members-ui.js', 'admin-create-user-ui.js', 'admin-gpu-tasks.js', 'admin-gpu-tasks.css', 'admin-maintenance-ui.js', 'host-diagnostics-ui.js',
  'vendor/fonts/Archivo-Variable.woff2',
  'vendor/fonts/Geist-Variable.woff2',
  'vendor/fonts/GeistMono-Variable.woff2',
].map(file => ['/' + file, file]));
