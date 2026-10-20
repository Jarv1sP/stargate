// Reuse real platform workflow fixtures; never connects to a live account or node.
// node tests/aispace-theme-ui-smoke.mjs [directory|settings|compute]
import {chromium} from 'playwright';
process.env.AISPACE_THEME='1';
const suites={directory:'directory-model-ui-smoke.mjs',settings:'project-settings-ui-smoke.mjs',compute:'compute-ui-smoke.mjs'};
const suite=suites[process.argv[2]||'directory'];
if(!suite)throw Error('Choose directory, settings or compute');
const launch=chromium.launch.bind(chromium);
chromium.launch=async options=>{
 const browser=await launch(options),newContext=browser.newContext.bind(browser);
 browser.newContext=async options=>{
  const context=await newContext(options);
  await context.addInitScript(()=>{
   const apply=()=>{
    if(location.pathname!=='/')return;
    if(!document.body?.classList.contains('sb'))return;
    if(!document.body.dataset.workshopLayout)document.body.dataset.workshopLayout='aispace';
   };
   new MutationObserver(apply).observe(document,{childList:true,subtree:true});apply();
  });
  return context;
 };
 return browser;
};
await import('./'+suite);
