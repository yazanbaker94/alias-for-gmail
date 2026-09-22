import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {normalizeConfig,validateConfig,DATA_USE_CONSENT_VERSION} from '../extension/lib/config.js';

test('standalone setup saves consent and provider, preserves opt-out and clears credentials',async()=>{
 const dom=new JSDOM(fs.readFileSync(new URL('../extension/options.html',import.meta.url),'utf8'),{runScripts:'outside-only'});
 const d=dom.window.document;let stored=normalizeConfig();
 Object.assign(dom.window,{getConfig:async()=>({...stored}),saveConfig:async c=>(stored=validateConfig({...stored,...c})),validateConfig,DATA_USE_CONSENT_VERSION,chrome:{runtime:{sendMessage:async()=>({ok:true,summary:null})}}});
 const source=fs.readFileSync(new URL('../extension/options.js',import.meta.url),'utf8').replace(/^import .*\n/,'');
 new vm.Script(source).runInContext(dom.getInternalVMContext());
 const tick=()=>new Promise(r=>setTimeout(r,10));await tick();
 assert.equal(d.querySelectorAll('[value="hosted"]').length,0);
 d.getElementById('fromAddress').value='support@example.com';d.getElementById('resendApiKey').value='re_'+'x'.repeat(30);
 const consent=d.getElementById('dataUseConsent');consent.checked=true;consent.dispatchEvent(new dom.window.Event('change'));
 d.getElementById('settingsForm').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await tick();
 assert.equal(stored.enabled,true);assert.equal(stored.dataUseConsentVersion,DATA_USE_CONSENT_VERSION);assert.equal(stored.provider,'resend');assert.equal(d.getElementById('resendApiKey').value,'');
 d.getElementById('enabled').checked=false;d.getElementById('settingsForm').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await tick();assert.equal(stored.enabled,false);assert.equal(stored.gmailIntegrationOptOut,true);
 d.getElementById('clearResendKeyButton').click();await tick();assert.equal(stored.resendApiKey,'');assert.equal(stored.enabled,false);
 for(const e of d.querySelectorAll('.nav-item')){e.click();assert.equal(d.querySelector(`[data-view-panel="${e.dataset.view}"]`).hidden,false);}
 dom.window.close();
});

test('retired provider and sending without consent fail closed',()=>{
 assert.throws(()=>validateConfig({provider:'hosted'}),/Choose/);
 assert.throws(()=>validateConfig({provider:'resend',enabled:true,fromAddress:'a@example.com',resendApiKey:'re_'+'x'.repeat(30)},{requireReady:true}),/disclosure/);
});
