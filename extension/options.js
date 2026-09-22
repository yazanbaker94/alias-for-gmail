import { getConfig, saveConfig, validateConfig, DATA_USE_CONSENT_VERSION } from './lib/config.js';
const $ = id => document.getElementById(id);
let saved;
const fields=['fromAddress','fromName','defaultBcc','cloudflareAccountId'];
function text(id,value){if($(id)) $(id).textContent=value;}
function view(name){
  document.querySelectorAll('[data-view-panel]').forEach(e=>{e.hidden=e.dataset.viewPanel!==name;e.classList.toggle('is-active',!e.hidden);});
  document.querySelectorAll('.nav-item').forEach(e=>{e.classList.toggle('is-active',e.dataset.view===name);if(e.dataset.view===name)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current');});
}
function notice(message){$('notice').hidden=false;text('notice',message);}
function config(){
 const c={...saved};
 for(const key of fields)c[key]=$(key).value;
 c.provider=document.querySelector('input[name="provider"]:checked')?.value||'resend';
 c.resendApiKey=$('resendApiKey').value.trim()||saved.resendApiKey;
 c.cloudflareApiToken=$('cloudflareApiToken').value.trim()||saved.cloudflareApiToken;
 c.dataUseConsentVersion=$('dataUseConsent').checked?DATA_USE_CONSENT_VERSION:0;
 c.enabled=$('enabled').checked;
 return c;
}
function readiness(c){try{validateConfig(c,{requireReady:true});return 'Alias is ready in Gmail';}catch(e){return e.message;}}
function render(){
 const c=config(), label=c.provider==='resend'?'Resend':'Cloudflare';
 $('resendPanel').hidden=c.provider!=='resend';$('cloudflarePanel').hidden=c.provider!=='cloudflare';
 for(const id of ['overviewProviderName','overviewDelivery','senderRouteProvider','senderProviderState'])text(id,label);
 text('overviewProviderMark',label==='Resend'?'R':'CF');text('overviewProviderDetail','Your provider account');
 for(const id of ['overviewFromAddress','senderRouteFrom','senderAllowedAddress','sidebarIdentity'])text(id,c.fromAddress||'Add your sender address');
 text('overviewFromName',c.fromName||'Your custom-domain identity');text('overviewDomain',c.fromAddress.split('@')[1]||'Not configured');
 const status=readiness(c), ready=status==='Alias is ready in Gmail';
 text('overviewSetupTitle',ready?status:'Alias is not active in Gmail');text('overviewSetupMessage',ready?'Save changes, then refresh Gmail.':status);
 text('sidebarStatus',ready?'Ready':'Setup incomplete');text('readinessBadge',ready?'Ready':'Setup incomplete');
 text('overviewEnabledState',c.enabled?'On':'Off');text('senderEnabledState',c.enabled?'On':'Off');
 text('resendKeyState',saved.resendApiKey?'Key saved locally':'No key saved');text('tokenState',saved.cloudflareApiToken?'Token saved locally':'No token saved');
 text('overviewDomainBadge','Verify with provider');
 $('resendUsageLink').hidden=c.provider!=='resend';
 text('capRecipients',c.provider==='resend'?'Up to 50':'Provider dependent');text('capCcBcc','Supported');text('capAttachments','Local files, up to 3 MiB total');text('capRequestSize','Provider limits also apply');
 text('usageProviderMessage','Alias does not read your provider quota or charge a subscription. Check your own provider account for usage and billing.');
}
async function diagnostics(){const r=await chrome.runtime.sendMessage({type:'GET_DIAGNOSTICS'});text('lastSendSummary',JSON.stringify(r.summary||{status:'No send recorded'},null,2));text('configurationChecks',readiness(await getConfig()));text('diagnosticNarrative','This check validates local configuration only; it does not verify your domain or API key with the provider.');}
async function init(){
 saved=await getConfig();
 for(const key of fields)$(key).value=saved[key];
 const selected=document.querySelector(`input[name="provider"][value="${['resend','cloudflare'].includes(saved.provider)?saved.provider:'resend'}"]`);selected.checked=true;
 $('dataUseConsent').checked=saved.dataUseConsentVersion>=DATA_USE_CONSENT_VERSION;$('enabled').checked=saved.enabled;
 document.querySelectorAll('[data-view]').forEach(e=>e.addEventListener('click',()=>view(e.dataset.view)));
 $('overviewSetupAction').addEventListener('click',()=>{if(!$('dataUseConsent').checked){$('dataUseConsent').focus();return;}view(!config().fromAddress?'sender':'delivery');});
 $('dataUseConsent').addEventListener('change',()=>{$('enabled').checked=$('dataUseConsent').checked;render();});
 $('settingsForm').addEventListener('input',()=>{text('unsavedHint','Unsaved changes');render();});
 $('settingsForm').addEventListener('change',render);
 $('settingsForm').addEventListener('submit',async e=>{e.preventDefault();try{let c=config();if(c.dataUseConsentVersion>=DATA_USE_CONSENT_VERSION&&!saved.gmailIntegrationOptOut)c.enabled=true;c.gmailIntegrationOptOut=!$('enabled').checked;if(c.gmailIntegrationOptOut)c.enabled=false;validateConfig(c,{requireReady:c.enabled});saved=await saveConfig(c);$('enabled').checked=saved.enabled;$('resendApiKey').value='';$('cloudflareApiToken').value='';text('unsavedHint','Saved');notice('Saved. Refresh Gmail to apply changes.');render();}catch(error){notice(error.message);}});
 for(const [id,key]of [['clearTokenButton','cloudflareApiToken'],['clearResendKeyButton','resendApiKey']])$(id).addEventListener('click',async()=>{saved=await saveConfig({[key]:'',enabled:false});$(key).value='';$('enabled').checked=false;render();notice('Credential removed. Gmail sending disabled.');});
 $('refreshDiagnosticsButton').addEventListener('click',diagnostics);
 $('clearDiagnosticsButton').addEventListener('click',async()=>{await chrome.runtime.sendMessage({type:'CLEAR_DIAGNOSTICS'});await diagnostics();});
 $('copyDiagnosticsButton').addEventListener('click',async()=>{try{await diagnostics();await navigator.clipboard.writeText($('lastSendSummary').textContent);notice('Diagnostics copied. Review before sharing publicly.');}catch{notice('Could not copy. Select and copy the diagnostics manually.');}});
 $('checkConfigurationButton').addEventListener('click',async()=>text('configurationCheckResult',readiness(await getConfig())));
 render();view('overview');await diagnostics();
}
init().catch(()=>notice('Unable to load settings. Reload the extension and try again.'));
