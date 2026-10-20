// Explicit frontend-only additions shared by the demo and the production portal.
// Keep static asset registration separate from every API and execution route.
export const STARBASE_ASSETS = Object.fromEntries([
  'themes/aispace.css','themes/aispace.js',
  'workshop-platform.js','workshop-native.js','workshop-package.js','workshop-ui.js','workshop-examples.js','workshop-runtime.js','workshop.css',
  'starbase-tokens.css', 'starbase-shell.css', 'starbase-controls.css', 'starbase-status.css', 'starbase-surfaces.css', 'starbase-overlays.css', 'starbase-responsive.css', 'starbase-motion.css', 'starbase-navigation-glass.css',
  'announcement-ui.js','announcement-appearance.js','announcements.css',
  'fonts.css', 'starbase.css', 'shell.css', 'workbench.css', 'terminal.css', 'resources.css', 'jobs-room.css', 'projects-room.css', 'data-room.css', 'collab-room.css', 'jobs-room.js', 'sheet-ui.js', 'apple-touch-icon.png', 'members.css', 'copy-help.css',
  'resource-orbits.js', 'shell-ui.js', 'control-ui.js', 'attention-state.js', 'workbench-ui.js', 'training-storage-ui.js', 'motion-ui.js', 'copy-help-ui.js', 'startup-ui.js', 'sky-ui.js', 'portal-shell.css', 'splash.css', 'navigation.js', 'toast-ui.js',
  'favicon.svg', 'favicon.ico', 'mask-icon.svg',
  'task-display-ui.js',
  'job-results-ui.js', 'time-format.js', 'trash-ui.js', 'file-transfer-ui.js',
  'maintenance-state.js', 'maintenance-experience.css',
  'admin-ui.js', 'admin.css', 'admin-room.js', 'admin-room.css',
  'vendor/fonts/Archivo-Variable.woff2',
  'vendor/fonts/Geist-Variable.woff2',
  'vendor/fonts/GeistMono-Variable.woff2',
].map(file => ['/' + file, file]));
