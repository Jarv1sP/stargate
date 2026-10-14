import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const installerPath = fileURLToPath(new URL('../deploy/install-client.ps1', import.meta.url));
const installer = readFileSync(installerPath, 'utf8');

test('Windows installer pins an HTTPS origin and bounds same-origin downloads', () => {
  assert.match(installer, /\$GpuqPublicOrigin = '__GPUQ_PUBLIC_ORIGIN__'/);
  assert.match(installer, /Scheme -cne 'https'/);
  for (const field of ['UserInfo', 'AbsolutePath', 'Query', 'Fragment']) assert.ok(installer.includes(`$parsed.${field}`));
  assert.match(installer, /AllowAutoRedirect = \$false/);
  assert.match(installer, /Resolve-GpuqOrigin \$Origin\) \+ '\/gpuctl\.mjs'/);
  assert.match(installer, /status -ne 200 -and \$status -ne 206/);
  assert.match(installer, /\$limit = 64 \* 1024 \* 1024/);
  assert.match(installer, /FromSeconds\(\[Math\]::Min\(120, \$remaining\)\)/);
  assert.match(installer, /AddSeconds\(900\)/);
  assert.doesNotMatch(installer, /SkipCertificateCheck|ServerCertificateCustomValidationCallback|TrustAll|ServerCertificateValidationCallback/);
});

test('Windows installer requires Node and never changes machine or script execution policies', () => {
  assert.match(installer, /Get-Command node\.exe -CommandType Application/);
  assert.match(installer, /Matches\[1\] -lt 22/);
  assert.match(installer, /Matches\[2\] -lt 13/);
  assert.doesNotMatch(installer, /Set-ExecutionPolicy|ExecutionPolicy\s+Bypass|netsh|New-NetFirewallRule|winget|choco|Start-Process|RunAs|wsl\.exe|bash\.exe/i);
  assert.match(installer, /GetFolderPath\(\[Environment\+SpecialFolder\]::LocalApplicationData\)/);
  assert.doesNotMatch(installer, /-Scope 'Machine'/);
  assert.match(installer, /function Add-GpuqPathEntry/);
  assert.match(installer, /OrdinalIgnoreCase/);
});

test('Windows installer validates before selecting an immutable release and rolls PATH back on failure', () => {
  const validation = installer.indexOf('& $NodePath --check $clientFile');
  const publish = installer.indexOf('[IO.Directory]::Move($stage, $release)');
  const commit = installer.indexOf('Move-GpuqLauncher -Source $temporaryLauncher');
  assert.ok(validation > 0 && publish > validation && commit > publish);
  assert.match(installer, /\[IO\.File\]::Replace\(\$Source, \$Destination, \$Backup\)/);
  assert.match(installer, /\[IO\.FileShare\]::None/);
  assert.match(installer, /Set-GpuqPathValue -Scope 'User' -Value \$oldUserPath/);
  assert.match(installer, /Set-GpuqPathValue -Scope 'Process' -Value \$oldProcessPath/);
  assert.match(installer, /if \(\$committed\).*?\$backup.*?else.*?\$release/);
  assert.match(installer, /setlocal DisableDelayedExpansion/);
  assert.match(installer, /%~dp0\.\.\\releases\\\$id\\gpuctl\.mjs/);
  assert.match(installer, /exit \/b %errorlevel%/);
  assert.match(installer, /\[Text\.Encoding\]::ASCII/);
});

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const probe = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 15000 });
function runOfflineHarness({ shortPath = false } = {}) {
  assert.equal(probe.status, 0, probe.stderr);
  const dir = mkdtempSync(join(tmpdir(), 'gpuq-windows-installer-'));
  try {
    const harness = fileURLToPath(new URL('./install-client-windows.ps1', import.meta.url));
    // -Command keeps the test independent of script-file execution policy, without changing it.
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const command = `& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(harness)}))) -Installer ${quote(installerPath)} -NodePath ${quote(process.execPath)} -TestRoot ${quote(dir)}${shortPath ? ' -ShortPathRegression' : ''}`;
    const run = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 90000 });
    assert.equal(run.status, 0, `${run.error || ''}\n${run.stdout}\n${run.stderr}`);
    return run.stdout;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('PowerShell offline installation, update and failure rollback', { skip: probe.error ? `${powershell} is not installed; run this test on Windows or a pwsh host` : false }, () => {
  assert.match(runOfflineHarness(), /PASS: fake-download Windows installer lifecycle/);
});

test('PowerShell lifecycle also accepts a real Windows 8.3 TEMP alias', { skip: process.platform !== 'win32' ? 'Requires Windows 8.3 filesystem paths' : probe.error ? 'Windows PowerShell is not installed' : false }, t => {
  const output = runOfflineHarness({ shortPath: true });
  if (output.includes('SKIP: this filesystem does not expose an 8.3 alias')) { t.skip('8.3 alias creation is disabled on this test filesystem'); return; }
  assert.match(output, /TESTING: 8\.3 short-path installation root/);
  assert.match(output, /PASS: fake-download Windows installer lifecycle/);
});
