import test from 'node:test';
import assert from 'node:assert/strict';
import {clientUpgradeMessage} from '../client-compatibility.mjs';
test('upgrade hint selects official installer and quotes URL safely on both platforms',()=>{
 const origin="https://portal.example:8443";
 const linux=clientUpgradeMessage(origin,'linux'),windows=clientUpgradeMessage(origin,'win32');
 assert.match(linux,/curl -fsS --max-redirs 0 'https:\/\/portal.example:8443\/install.sh' \| sh/);
 assert.match(windows,/Invoke-WebRequest 'https:\/\/portal.example:8443\/install.ps1'.*-MaximumRedirection 0/);
 assert.doesNotMatch(linux,/install.ps1/);assert.doesNotMatch(windows,/install.sh/);
 assert.throws(()=>clientUpgradeMessage('https://user:password@portal.example'));
});
