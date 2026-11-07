/* Manual payment UI. All permissions and balance changes are enforced by the server. */
function setupPayments({ $, api, amount, format, node, refreshAccount, showMessage, getConfig, isSignedIn }) {
  let state, currentDeposit, currentReview, receiptData = null;
  let refreshSequence = 0, proofMode = 'transaction', historyFilter = 'all', adminTab = 'deposit', queueSequence = 0;
  const retryKeys = new Map();
  const methodName = id => id === 'cbe' ? 'CBE' : 'Telebirr';
  const statuses = {draft:'Awaiting your payment proof',pending:'Pending review',processing:'Processing withdrawal',approved:'Deposit credited',rejected:'Rejected',paid:'Withdrawal paid',failed:'Payout failed; funds returned',cancelled:'Cancelled'};
  async function mutate(route, data) {
    const fingerprint = route + JSON.stringify(data);
    if (!retryKeys.has(fingerprint)) retryKeys.set(fingerprint, crypto.randomUUID());
    const result = await api(route, data, retryKeys.get(fingerprint));
    retryKeys.delete(fingerprint); return result;
  }
  async function run(button, errorId, fn) {
    button.disabled = true; $(errorId).textContent = '';
    try { await fn(); } catch(error) { $(errorId).textContent = error.message; if (!$(errorId).getClientRects().length) showMessage(error.message); }
    finally { button.disabled = false; }
  }
  function detail(container,label,value) {
    const row=node('div','','payment-detail-row');row.append(node('small',label),node('strong',String(value ?? '-')));container.append(row);
  }
  function showStep(id,title) {
    for(const step of ['deposit-create-form','deposit-details','deposit-proof-form','withdrawal-form','payment-submitted'])$(step).hidden=step!==id;
    $('payment-title').textContent=title;$('payment-error').textContent='';
  }
  function selectProof(mode) {
    proofMode=mode;
    for(const value of ['transaction','screenshot']){
      const selected=value===mode,tab=$(`proof-${value}-tab`);
      tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
      $(`proof-${value}-panel`).hidden=!selected;
    }
    $('deposit-reference').required=mode==='transaction';$('deposit-reference').disabled=mode!=='transaction';
    $('deposit-receipt').required=mode==='screenshot';$('deposit-receipt').disabled=mode!=='screenshot';
    $('payment-error').textContent='';
  }
  for(const mode of ['transaction','screenshot']){
    $(`proof-${mode}-tab`).onclick=()=>selectProof(mode);
    $(`proof-${mode}-tab`).onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'transaction':event.key==='End'?'screenshot':proofMode==='transaction'?'screenshot':'transaction';selectProof(next);$(`proof-${next}-tab`).focus();}};
  }
  $('payment-back').onclick=()=>{if(!$('deposit-proof-form').hidden)renderDeposit(currentDeposit);else $('payment-dialog').close();};
  function submitted(title,description) {
    showStep('payment-submitted',title);$('payment-submitted-title').textContent=title;$('payment-submitted-description').textContent=description;showMessage(title,2000);
  }
  function renderDeposit(request) {
    if(currentDeposit?.id!==request.id){selectProof('transaction');receiptData=null;$('deposit-proof-form').reset();$('receipt-preview').removeAttribute('src');$('receipt-preview').hidden=true;}
    currentDeposit=request;showStep('deposit-details','Payment details');const box=$('deposit-details-content');box.replaceChildren();
    detail(box,'Amount',`${format(request.amount)} ETB`);detail(box,'Payment method',methodName(request.method));detail(box,'Account-holder name',request.receiver_holder);detail(box,'Receiving account',request.receiver_account);const logo=node('img');logo.src=`/assets/payments/${request.method}.png`;logo.alt=methodName(request.method);logo.className='payment-detail-logo';box.children[1].append(logo);
    if(request.bonus){detail(box,`${request.bonus.rate_bps/100}% deposit bonus`,`${format(request.bonus.amount)} ETB after approval`);detail(box,'Total playable balance added',`${format(request.amount+request.bonus.amount)} ETB`);box.append(node('p','Bonus is playable after approval. Its amount stays held from withdrawals until you complete 6 cash rounds started after approval. Each round counts once; canceled and refunded rounds do not count.'));}
    $('payment-dialog').showModal();
  }
  async function refresh() {
    const sequence=++refreshSequence;
    const data=await api('/api/payments');if(!isSignedIn()||sequence!==refreshSequence)return;state=data;
    $('cash-balance').textContent=format(data.wallet.available);$('cash-reserved').textContent=`Reserved: ${format(data.wallet.reserved)} ETB${data.wallet.bonusLocked?` · Bonus held: ${format(data.wallet.bonusLocked)} ETB · Withdrawable: ${format(data.wallet.withdrawable)} ETB`:''}`;
    if(getConfig().manualPayments)$('header-balance').textContent=`${format(data.wallet.available)} ETB`;
    $('payments-availability').hidden=data.enabled;
    $('payments-availability').textContent=data.enabled?'':'Deposits and withdrawals are being configured. Do not send money yet.';
    $('cash-deposit').disabled=!data.methods.some(m=>m.available);$('header-deposit').disabled=$('cash-deposit').disabled;$('cash-withdraw').disabled=!data.enabled;
    $('payment-admin-open').hidden=!data.role;
    for(const input of document.querySelectorAll('[name="deposit-method"]')) input.disabled=!data.methods.find(m=>m.id===input.value)?.available;
    renderHistory();
  }
  function renderHistory(){
    if(!state)return;
    const requests=state.requests.filter(r=>historyFilter==='all'||r.kind===historyFilter);
    const pending=state.requests.filter(r=>r.kind==='deposit'&&r.status==='pending').length;
    $('payment-tracking-summary').textContent=pending?`${pending} deposit${pending===1?'':'s'} awaiting verification`:'Follow your payment status below';
    const history=$('payment-history');history.replaceChildren();
    for(const request of requests){
      const incoming=request.kind==='deposit';
      const card=node('button','',`payment-history-item compact-transaction ${incoming?'incoming':'outgoing'}`);card.type='button';
      const date=new Date(request.created_at).toLocaleString();
      card.setAttribute('aria-label',`${incoming?'Deposit':'Withdrawal'}, ${format(request.amount)} ETB, ${date}. View details`);
      const arrow=node('span',incoming?'\u2199':'\u2197','transaction-arrow');arrow.setAttribute('aria-hidden','true');
      const content=node('span','','transaction-brief');content.append(node('strong',`${format(request.amount)} ETB`),node('small',date));
      card.append(arrow,content);
      const label=['approved','paid'].includes(request.status)?'Completed':['cancelled','rejected','failed'].includes(request.status)?'Canceled':'Pending';card.append(node('span',label,`transaction-state transaction-state-${label.toLowerCase()}`));
      card.onclick=()=>showTransactionDetails(request);history.append(card);
    }
    if(!requests.length)history.append(node('p',historyFilter==='all'?'Your deposit and withdrawal requests will appear here.':`No ${historyFilter}s yet.`));
  }
  function showTransactionDetails(request){
      const card=node('div','','payment-history-item');const top=node('div','','section-title');top.append(node('strong',`${request.kind==='deposit'?'Deposit':'Withdrawal'} - ${methodName(request.method)}`),node('strong',`${format(request.amount)} ETB`));card.append(top,node('span',statuses[request.status]||request.status,`payment-status status-${request.status}`),node('small',new Date(request.created_at).toLocaleString()));
      if(request.kind==='deposit'){
        const progress=node('ol','','deposit-progress');progress.setAttribute('aria-label','Deposit progress');
        const stage={draft:0,pending:1,approved:2}[request.status];
        if(stage!==undefined){for(const [i,label] of ['Payment details','Under review','Credited'].entries()){const step=node('li',label,i<=stage?'complete':'');if(i===stage)step.setAttribute('aria-current','step');progress.append(step);}card.append(progress);}
        const explanations={draft:'Transfer the amount, then submit your transaction ID or screenshot.',pending:'Your proof has been submitted. An agent is checking the receiving account.',approved:'The verified deposit has been added to your cash balance.',rejected:'This deposit was not credited. See the review reason below.',cancelled:'This request is closed. Any bank transfer is not reversed automatically.'};
        card.append(node('p',explanations[request.status]||'','tracking-description'));
      }
      card.append(node('small',`Request: ${request.id}`,'payment-request-id'));
      if(request.bonus)card.append(node('p',`${request.bonus.rate_bps/100}% bonus: ${format(request.bonus.amount)} ETB · ${request.bonus.status==='credited'?(request.bonus.unlocked?'Unlocked':`${request.bonus.roundsCompleted}/6 rounds completed`):request.bonus.status}`));
      if(request.updated_at&&request.updated_at!==request.created_at)card.append(node('small',`Updated ${new Date(request.updated_at).toLocaleString()}`));
      if(request.reference)card.append(node('small',`Transaction: ${request.reference}`));
      if(request.reason)card.append(node('p',request.reason));
      const controls=node('div','','row');
      if(request.kind==='deposit'&&request.status==='draft'){const resume=node('button','Payment details','secondary');resume.onclick=()=>{$('transaction-detail-dialog').close();renderDeposit(request);};controls.append(resume);}
      if(request.status==='draft'||(request.kind==='withdrawal'&&request.status==='pending')){const cancel=node('button','Cancel request','text-button');cancel.onclick=()=>run(cancel,'payment-error',async()=>{await mutate(`/api/payments/${request.id}/cancel`,{});await refreshAccount();$('transaction-detail-dialog').close();showMessage('Request cancelled',2000);}).catch(()=>{});controls.append(cancel);}
      if(request.hasReceipt){const link=node('a','View submitted receipt','receipt-link');link.href=`/api/payments/${request.id}/receipt`;link.target='_blank';link.rel='noopener';controls.append(link);}
      card.append(controls);$('transaction-detail-content').replaceChildren(card);$('transaction-detail-dialog').showModal();
  }
  for(const button of document.querySelectorAll('[data-payment-filter]'))button.onclick=()=>{historyFilter=button.dataset.paymentFilter;for(const tab of document.querySelectorAll('[data-payment-filter]'))tab.setAttribute('aria-pressed',String(tab===button));renderHistory();};
  $('cash-deposit').onclick=()=>{
    if(!state?.enabled)return;
    currentDeposit=null;selectProof('transaction');receiptData=null;$('deposit-proof-form').reset();$('receipt-preview').hidden=true;$('receipt-preview').removeAttribute('src');
    const method=[...document.querySelectorAll('[name="deposit-method"]')].find(i=>!i.disabled);if(method)method.checked=true;
    showStep('deposit-create-form','Deposit money');$('payment-dialog').showModal();
  };
  $('cash-withdraw').onclick=()=>{if(!state?.enabled)return;showStep('withdrawal-form','Withdraw money');$('withdrawal-available').textContent=`Withdrawable: ${format(state.wallet.withdrawable??state.wallet.available)} ETB`;$('payment-dialog').showModal();};
  for(const b of document.querySelectorAll('[data-deposit-amount]'))b.onclick=()=>{$('deposit-amount').value=b.dataset.depositAmount;};
  $('deposit-create-form').onsubmit=event=>{event.preventDefault();run(event.submitter,'payment-error',async()=>{
    const method=document.querySelector('[name="deposit-method"]:checked')?.value;const request=await mutate('/api/payments/deposits',{method,amount:amount('deposit-amount')});renderDeposit(request);await refreshAccount();
  });};
  $('copy-payment-account').onclick=()=>run($('copy-payment-account'),'payment-error',async()=>{try{await navigator.clipboard.writeText(currentDeposit.receiver_account);showMessage('Account number copied',2000);}catch{throw new Error('Copy is unavailable. Select and copy the account number shown above.');}});
  $('deposit-paid').onclick=()=>{showStep('deposit-proof-form','Verify payment');$('proof-summary').textContent=`${format(currentDeposit.amount)} ETB`;};
  $('proof-back').onclick=()=>renderDeposit(currentDeposit);
  $('deposit-cancel').onclick=()=>run($('deposit-cancel'),'payment-error',async()=>{await mutate(`/api/payments/${currentDeposit.id}/cancel`,{});submitted('Request cancelled','This does not reverse a bank transfer. If you already sent money, contact the owner before creating another request.');await refreshAccount();});
  $('deposit-receipt').onchange=async()=>{
    receiptData=null;$('receipt-preview').hidden=true;$('receipt-preview').removeAttribute('src');$('payment-error').textContent='';
    const file=$('deposit-receipt').files[0];if(!file)return;
    if(!['image/png','image/jpeg'].includes(file.type)||file.size>2*1024*1024){$('payment-error').textContent='Choose a PNG or JPG image up to 2 MB.';$('deposit-receipt').value='';return;}
    try{const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});if($('deposit-receipt').files[0]!==file)return;receiptData={type:file.type,base64:data.split(',')[1]};$('receipt-preview').src=data;$('receipt-preview').hidden=false;}catch{$('payment-error').textContent='Could not read that image. Please choose it again.';}
  };
  $('deposit-proof-form').onsubmit=event=>{event.preventDefault();run(event.submitter,'payment-error',async()=>{
    if(!currentDeposit)throw new Error('Select a deposit request first.');
    if(proofMode==='transaction'&&!$('deposit-reference').value.trim())throw new Error('Enter your transaction ID.');
    if(proofMode==='screenshot'&&!receiptData)throw new Error('Choose a screenshot and wait for its preview.');
    await mutate(`/api/payments/${currentDeposit.id}/proof`,{reference:proofMode==='transaction'?$('deposit-reference').value.trim():'',receipt:proofMode==='screenshot'?receiptData:null});receiptData=null;$('deposit-proof-form').reset();$('receipt-preview').removeAttribute('src');$('receipt-preview').hidden=true;
    submitted('Submitted for review','Your deposit is pending. Your balance will update after an agent confirms receipt in the receiving account.');await refreshAccount();
  });};
  function updateWithdrawalMethod(){const telebirr=document.querySelector('[name="withdrawal-method"]:checked').value==='telebirr';$('withdrawal-account-label').textContent=telebirr?'Telebirr phone number':'CBE account number';$('withdrawal-account').placeholder=telebirr?'Enter your Telebirr number':'Enter your CBE account number';$('withdrawal-account').inputMode=telebirr?'tel':'numeric';}
  for(const input of document.querySelectorAll('[name="withdrawal-method"]'))input.onchange=updateWithdrawalMethod;
  for(const button of document.querySelectorAll('[data-withdrawal-amount]'))button.onclick=()=>{$('withdrawal-amount').value=button.dataset.withdrawalAmount;};
  $('withdrawal-form').onsubmit=event=>{event.preventDefault();run(event.submitter,'payment-error',async()=>{
    await mutate('/api/payments/withdrawals',{method:document.querySelector('[name="withdrawal-method"]:checked').value,amount:amount('withdrawal-amount'),account:$('withdrawal-account').value.trim()});$('withdrawal-form').reset();updateWithdrawalMethod();submitted('Withdrawal requested','The amount is reserved. An agent will review and process your payout; you can follow its status in your wallet.');await refreshAccount();
  });};
  $('payment-history-refresh').onclick=()=>run($('payment-history-refresh'),'payment-error',refreshAccount);
  async function loadQueue(){const sequence=++queueSequence;const data=await api('/api/admin/payments');if(!isSignedIn()||sequence!==queueSequence)return;const box=$('payment-queue');box.replaceChildren();
    for(const request of data.requests.filter(r=>r.kind===adminTab)){const b=node('button','',`review-queue-item compact-transaction ${request.kind==='deposit'?'incoming':'outgoing'}`);const arrow=node('span',request.kind==='deposit'?'\u2199':'\u2197','transaction-arrow');arrow.setAttribute('aria-hidden','true');const brief=node('span','','transaction-brief');brief.append(node('strong',`${format(request.amount)} ETB`),node('small',new Date(request.created_at).toLocaleString()));b.append(arrow,brief,node('span','Pending','transaction-state transaction-state-pending'));b.setAttribute('aria-label',`${request.kind} ${format(request.amount)} ETB - ${statuses[request.status]}`);b.onclick=()=>run(b,'payment-admin-error',()=>openReview(request));box.append(b);}
    if(!data.requests.some(r=>r.kind===adminTab))box.append(node('p',adminTab==='deposit'?'No deposits awaiting review.':'No withdrawals awaiting review.'));
  }
  async function openReview(request){currentReview=request;$('payment-review-panel').hidden=false;$('payment-review-form').reset();const box=$('payment-review-details');box.replaceChildren();
    detail(box,'Request ID',request.id);detail(box,'User',request.user_id);detail(box,'Type / method',`${request.kind} / ${methodName(request.method)}`);detail(box,'Amount',`${format(request.amount)} ETB`);detail(box,'Status',statuses[request.status]);detail(box,'Account-holder name',request.kind==='deposit'?request.receiver_holder:request.holder);detail(box,'Receiving account',request.kind==='deposit'?request.receiver_account:request.destination);if(request.kind==='deposit'){detail(box,'Claimed transaction ID',request.reference||'Screenshot only');detail(box,'Claimed sender',request.holder);}if(request.reviewer_id)detail(box,'Assigned payout reviewer',request.reviewer_id);
    $('review-receipt').hidden=!request.hasReceipt;if(request.hasReceipt)$('review-receipt').src=`/api/payments/${request.id}/receipt`;else $('review-receipt').removeAttribute('src');
    $('deposit-review-actions').hidden=request.kind!=='deposit';$('payment-review-form').hidden=request.kind==='deposit';
    if(request.kind==='withdrawal')detail(box,'Transfer instructions',request.status==='pending'?'Reserve payout allowance successfully before sending any money.':'Allowance reserved. Do not mark failed unless you have confirmed no money was sent.');
    const choices=request.kind==='deposit'?[['approve','Approve verified deposit'],['reject','Reject deposit']]:request.status==='pending'?[['claim','Reserve payout allowance before transfer'],['reject','Reject withdrawal']]:[['paid','Record successful payout'],['failed','Confirm payout failed; return funds']];
    $('review-action').replaceChildren(...choices.map(([value,label])=>{const o=node('option',label);o.value=value;return o;}));reviewFields();
    const audit=await api(`/api/admin/payments/${request.id}/audit`);if(currentReview?.id!==request.id)return;$('payment-audit').replaceChildren(...audit.events.map(e=>node('p',`${new Date(e.created_at).toLocaleString()} - ${e.actor_id} - ${e.action}`)));
    $('payment-review-panel').scrollIntoView({block:'start',behavior:'smooth'});
  }
  function reviewFields(){const action=$('review-action').value;const verification=['approve','paid'].includes(action),rejection=['reject','failed'].includes(action);
    $('review-verification').hidden=!verification;$('review-verification').disabled=!verification;$('review-rejection').hidden=!rejection;$('review-rejection').disabled=!rejection;
    $('review-sender-label').hidden=action!=='approve';$('review-not-sent-label').hidden=action!=='failed';
    for(const id of ['review-reference','review-amount','review-recipient','review-bank-confirmed'])$(id).required=verification;
    $('review-sender').required=action==='approve';$('review-reason').required=rejection;$('review-not-sent').required=action==='failed';
  }
  for(const action of ['approve','reject'])$(`${action}-deposit`).onclick=()=>run($(`${action}-deposit`),'payment-admin-error',async()=>{
    if(!currentReview||currentReview.kind!=='deposit')throw new Error('Select a deposit first.');
    $('approve-deposit').disabled=true;$('reject-deposit').disabled=true;
    try{await mutate(`/api/admin/payments/${currentReview.id}/review`,{action});$('payment-review-panel').hidden=true;currentReview=null;$('review-receipt').removeAttribute('src');await loadQueue();await refreshAccount();showMessage(action==='approve'?'Deposit approved':'Deposit rejected',2000);}
    finally{$('approve-deposit').disabled=false;$('reject-deposit').disabled=false;}
  });
  $('review-action').onchange=reviewFields;
  $('payment-review-form').onsubmit=event=>{event.preventDefault();run(event.submitter,'payment-admin-error',async()=>{
    const action=$('review-action').value;const data={action};
    if(['approve','paid'].includes(action))Object.assign(data,{verifiedReference:$('review-reference').value.trim(),verifiedAmount:amount('review-amount'),verifiedRecipient:$('review-recipient').value.trim(),verifiedSender:$('review-sender').value.trim(),bankConfirmed:$('review-bank-confirmed').checked});
    if(['reject','failed'].includes(action))Object.assign(data,{reason:$('review-reason').value.trim(),fundsNotSent:$('review-not-sent').checked});
    await mutate(`/api/admin/payments/${currentReview.id}/review`,data);$('payment-review-panel').hidden=true;currentReview=null;$('review-receipt').removeAttribute('src');await loadQueue();await refreshAccount();showMessage('Payment review saved',2000);
  });};
  let ownerSettings=null;
  const pickerOptions=new Map();
  function pickerSummary(id){const selected=$(id).selectedOptions[0];$(`${id}-summary`).textContent=selected?.textContent||'Select an option';}
  function renderPicker(id){
    const query=$(`${id}-search`).value.toLowerCase().trim();const items=(pickerOptions.get(id)||[]).filter(item=>item.label.toLowerCase().includes(query));const list=$(`${id}-options`);list.replaceChildren();
    for(const item of items){const option=node('button','','picker-option');option.type='button';option.setAttribute('role','option');option.setAttribute('aria-selected',String($(id).selectedIndex>=0&&$(id).value===item.value));option.dataset.value=item.value;option.append(node('span',item.label),node('span',$(id).selectedIndex>=0&&$(id).value===item.value?'\u2713':'','picker-check'));option.onclick=()=>{$(id).value=item.value;$(id).dispatchEvent(new Event('change'));$(`${id}-summary`).focus();};list.append(option);}
    if(!items.length)list.append(node('p',query?'No matches found. Try another name or number.':'No options available yet.','picker-empty'));
  }
  function fillPicker(id,items,value){pickerOptions.set(id,items);$(`${id}-search`).value='';$(id).replaceChildren(...items.map(item=>{const o=node('option',item.label);o.value=item.value;return o;}));$(id).value=value??items[0]?.value??'';pickerSummary(id);renderPicker(id);}
  const pickerIds=['receiver-agent','receiver-number','receiver-holder','new-receiver-agent','agent-telegram-id'];
  for(const id of pickerIds){
    const wrapper=$(`${id}-picker`),details=wrapper.querySelector('details'),summary=$(`${id}-summary`),search=$(`${id}-search`);
    $(id).required=false;$(id).hidden=true;
    summary.setAttribute('aria-expanded','false');summary.setAttribute('aria-controls',`${id}-popup`);
    const popup=node('div','','picker-popup');popup.id=`${id}-popup`;
    const searchBox=node('div','','picker-search');const icon=node('span','\u2315','picker-search-icon');icon.setAttribute('aria-hidden','true');searchBox.append(icon,search);
    const list=node('div','','picker-options');list.id=`${id}-options`;list.setAttribute('role','listbox');list.setAttribute('aria-label',$(id).getAttribute('aria-label'));popup.append(searchBox,list);details.append(popup);
    search.oninput=()=>renderPicker(id);
    details.ontoggle=()=>{summary.setAttribute('aria-expanded',String(details.open));if(details.open){for(const other of pickerIds)if(other!==id)$(`${other}-picker`).querySelector('details').open=false;search.value='';renderPicker(id);search.focus();popup.scrollIntoView({block:'nearest'});}};
    $(id).onchange=()=>{pickerSummary(id);details.open=false;if(id==='receiver-agent')updateAccountPickers();if(id==='receiver-number'||id==='receiver-holder')selectSavedAccount($(id).value);renderPicker(id);};
    details.onkeydown=event=>{
      if(event.key==='Escape'&&details.open){event.preventDefault();event.stopPropagation();details.open=false;summary.focus();return;}
      if(!details.open)return;
      const options=[...list.querySelectorAll('button')],index=options.indexOf(document.activeElement);
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const next=index<0?(event.key==='ArrowDown'?0:options.length-1):(index+(event.key==='ArrowDown'?1:options.length-1))%options.length;options[next]?.focus();}
      if(event.key==='Enter'&&document.activeElement===search){event.preventDefault();options[0]?.click();}
      if(index>=0&&(event.key==='Home'||event.key==='End')){event.preventDefault();(event.key==='Home'?options[0]:options.at(-1))?.focus();}
    };
    details.addEventListener('focusout',()=>setTimeout(()=>{if(!details.contains(document.activeElement))details.open=false;},0));
  }
  document.addEventListener('pointerdown',event=>{for(const id of pickerIds){const wrapper=$(`${id}-picker`);if(!wrapper.contains(event.target))wrapper.querySelector('details').open=false;}});
  function selectSavedAccount(id){for(const field of ['receiver-number','receiver-holder']){const items=pickerOptions.get(field)||[];fillPicker(field,items,id);}}
  function updateAccountPickers(){
    if(!ownerSettings)return;
    const agent=$('receiver-agent').value,method=$('receiver-method').value,seen=new Set();
    const accounts=ownerSettings.accounts.filter(a=>{const key=[a.method,a.account,a.holder,a.agent_id].join('|');if(a.method!==method||(a.agent_id||'')!==agent||seen.has(key))return false;seen.add(key);return true;});
    fillPicker('receiver-number',accounts.map(a=>({value:a.id,label:`${a.account} - ${a.holder}`})));
    fillPicker('receiver-holder',accounts.map(a=>({value:a.id,label:`${a.holder} - ${a.account}`})));
    $('receiver-empty').hidden=accounts.length>0;$('receiving-account-form').querySelector('button[type=submit]').disabled=!accounts.length;
  }
  $('receiver-method').onchange=updateAccountPickers;
  async function loadSettings(){if(state?.role!=='owner')return;const data=await api('/api/admin/payments/settings');if(!isSignedIn()||state?.role!=='owner')return;ownerSettings=data;const box=$('receiving-account-list');box.replaceChildren();
    for(const a of data.accounts.filter(a=>a.active)){const card=node('div','','payment-history-item');card.append(node('strong',`${methodName(a.method)} - ${a.holder}`),node('p',a.account),node('small',`Reviewer: ${data.agents.find(agent=>agent.user_id===a.agent_id)?.name||'Owner'}`));box.append(card);}
    const agents=[{value:'',label:'Owner'},...data.agents.filter(a=>a.enabled).map(a=>({value:a.user_id,label:`${a.name} (${a.user_id.slice(3)})`}))];
    fillPicker('receiver-agent',agents);fillPicker('new-receiver-agent',agents);
    fillPicker('agent-telegram-id',data.users.filter(u=>!data.agents.some(a=>a.user_id===u.id&&a.enabled)).map(u=>({value:u.id.slice(3),label:`${u.name} (${u.id.slice(3)})`})),'');
    updateAccountPickers();$('payment-agent-list').replaceChildren();
    for(const a of data.agents){const row=node('div','','transaction');row.append(node('span',`${a.name} - ${a.user_id} - ${a.enabled?'Enabled':'Disabled'}`));const b=node('button',a.enabled?'Disable':'Enable','secondary');b.onclick=()=>run(b,'payment-admin-error',async()=>{await mutate('/api/admin/payments/agents',{telegramId:a.user_id.slice(3),enabled:!a.enabled});await loadSettings();});row.append(b);$('payment-agent-list').append(row);}
  }
  async function selectAdminTab(tab){
    if(tab==='agents'&&state?.role!=='owner')return;
    adminTab=tab;queueSequence++;currentReview=null;$('payment-review-panel').hidden=true;$('review-receipt').removeAttribute('src');$('payment-admin-error').textContent='';
    for(const button of document.querySelectorAll('[data-admin-tab]')){const selected=button.dataset.adminTab===tab;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}
    $('admin-requests-panel').hidden=tab==='agents';$('payment-owner-panel').hidden=tab!=='agents';
    if(tab==='agents')await loadSettings();else{$('admin-requests-panel').setAttribute('aria-labelledby',`admin-${tab}-tab`);$('payment-queue').replaceChildren(node('p','Loading requests?'));await loadQueue();}
  }
  for(const button of document.querySelectorAll('[data-admin-tab]')){
    button.onclick=()=>selectAdminTab(button.dataset.adminTab).catch(error=>{$('payment-admin-error').textContent=error.message;});
    button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('[data-admin-tab]')].filter(t=>!t.hidden);const index=tabs.indexOf(button);const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];next.focus();next.click();};
  }
  $('payment-admin-open').onclick=()=>run($('payment-admin-open'),'payment-admin-error',async()=>{$('payment-admin-dialog').showModal();$('admin-agents-tab').hidden=state?.role!=='owner';await selectAdminTab('deposit');});
  $('payment-queue-refresh').onclick=()=>run($('payment-queue-refresh'),'payment-admin-error',loadQueue);
  $('receiving-account-form').onsubmit=event=>{event.preventDefault();run(event.submitter,'payment-admin-error',async()=>{
    const selected=ownerSettings?.accounts.find(a=>a.id===$('receiver-number').value);
    if(!selected||$('receiver-holder').value!==selected.id||selected.method!==$('receiver-method').value||(selected.agent_id||'')!==$('receiver-agent').value)throw new Error('Select a saved account and its matching holder.');
    await mutate('/api/admin/payments/accounts',{method:selected.method,account:selected.account,holder:selected.holder,agentId:selected.agent_id?.slice(3)||''});await loadSettings();await refresh();showMessage('Receiving account updated for new deposits',2000);
  });};
  $('new-receiving-account-form').onsubmit=event=>{event.preventDefault();run(event.submitter,'payment-admin-error',async()=>{
    if($('new-receiver-agent').selectedIndex<0)throw new Error('Select a reviewer.');
    await mutate('/api/admin/payments/accounts',{method:$('new-receiver-method').value,account:$('new-receiver-number').value.trim(),holder:$('new-receiver-holder').value.trim(),agentId:$('new-receiver-agent').value.replace(/^tg:/,'')});$('new-receiving-account-form').reset();await loadSettings();await refresh();showMessage('Receiving account saved and activated',2000);
  });};
  $('payment-agent-form').onsubmit=event=>{event.preventDefault();run(event.submitter,'payment-admin-error',async()=>{await mutate('/api/admin/payments/agents',{telegramId:$('agent-telegram-id').value.trim(),enabled:true});$('payment-agent-form').reset();await loadSettings();showMessage('Agent access enabled',2000);});};
  setInterval(()=>{if(isSignedIn()&&!document.hidden&&($('account-dialog').open||$('payment-dialog').open))refresh().catch(()=>{});},15000);
  return {refresh,reset(){ownerSettings=null;pickerOptions.clear();for(const id of pickerIds){$(id).replaceChildren();$(`${id}-options`).replaceChildren();$(`${id}-search`).value='';$(`${id}-summary`).textContent='Choose an option';$(`${id}-picker`).querySelector('details').open=false;}refreshSequence++;queueSequence++;state=null;currentDeposit=null;currentReview=null;receiptData=null;retryKeys.clear();$('payment-dialog').close();$('payment-admin-dialog').close();$('transaction-detail-dialog').close();$('transaction-detail-content').replaceChildren();for(const id of ['payment-history','payment-queue','payment-review-details','payment-audit','receiving-account-list','payment-agent-list','deposit-details-content'])$(id).replaceChildren();for(const id of ['review-receipt','receipt-preview']){$(id).removeAttribute('src');$(id).hidden=true;}for(const id of ['deposit-proof-form','withdrawal-form','payment-review-form'])$(id).reset();$('payment-admin-open').hidden=true;}};
}
