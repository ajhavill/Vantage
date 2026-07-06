/* Vantage — deal-links: the connective tissue between the portal (Market /
   Clients / Questionnaires / Tenants) and the Deals pipeline (deals.html).
   Turns "I found something" moments into a deal without re-typing anything:
     - DealLinks.openAddToDeal(building)       → add a building to an existing or new deal
     - DealLinks.startDealFromIntake(it, props)→ questionnaire → deal seeded with top matches
     - DealLinks.startPursuit(opts)            → client/tenant → new deal (carries hs_company_id)
   Self-contained like van.js: injects its own .dlk- CSS, uses the page's
   window.vantageSB Supabase session, and writes through the same RLS the
   deals pages use. Inserts mirror deals.html's contracts exactly, including
   its pre-migration fallbacks (stage check constraint, hs_company_id column). */
(function(){
  'use strict';
  if (window.DealLinks) return;

  /* ---------- css ---------- */
  var css = '' +
    '.dlk-overlay{position:fixed;inset:0;background:rgba(12,26,38,.45);backdrop-filter:blur(2px);z-index:2147482000;display:flex;align-items:center;justify-content:center;padding:18px}' +
    '.dlk-box{background:var(--card,#fff);color:var(--ink,#12283a);border-radius:14px;box-shadow:0 24px 64px rgba(10,25,40,.35);width:min(440px,94vw);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif}' +
    '.dlk-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line,#e3e9ef)}' +
    '.dlk-head h3{margin:0;font-size:15.5px}' +
    '.dlk-x{border:0;background:none;font-size:19px;cursor:pointer;color:var(--muted,#5b7183);line-height:1;padding:2px 6px}' +
    '.dlk-body{padding:14px 16px;overflow-y:auto}' +
    '.dlk-sub{color:var(--muted,#5b7183);font-size:12.5px;margin:0 0 10px}' +
    '.dlk-list{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;max-height:250px;overflow-y:auto}' +
    '.dlk-deal{display:flex;align-items:center;gap:10px;border:1px solid var(--line,#e3e9ef);border-radius:10px;padding:9px 11px;cursor:pointer;background:none;text-align:left;width:100%;font:inherit;color:inherit}' +
    '.dlk-deal:hover{border-color:var(--accent,#2d6e7e);background:rgba(45,110,126,.05)}' +
    '.dlk-deal b{font-size:13.5px}' +
    '.dlk-deal .st{margin-left:auto;font-size:11px;color:var(--muted,#5b7183);white-space:nowrap;background:var(--bg,#f2f5f8);border-radius:99px;padding:2px 8px}' +
    '.dlk-newrow{display:flex;gap:8px;margin-top:2px}' +
    '.dlk-newrow input{flex:1;border:1px solid var(--line,#dbe3ea);border-radius:9px;padding:8px 10px;font:inherit;min-width:0}' +
    '.dlk-btn{border:0;border-radius:9px;padding:8px 13px;font:600 13px system-ui,Segoe UI,Roboto,sans-serif;cursor:pointer;background:var(--accent,#2d6e7e);color:#fff;white-space:nowrap}' +
    '.dlk-btn[disabled]{opacity:.55;cursor:default}' +
    '.dlk-tour{display:flex;align-items:center;gap:7px;margin-top:11px;font-size:12.5px;color:var(--muted,#5b7183);cursor:pointer;user-select:none}' +
    '.dlk-err{color:#b3372f;font-size:12.5px;margin-top:9px}' +
    '.dlk-empty{color:var(--muted,#5b7183);font-size:12.5px;padding:6px 2px}' +
    '.dlk-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147482500;background:var(--navy,#12283a);color:#fff;border-radius:11px;padding:11px 16px;font:13px/1.4 system-ui,Segoe UI,Roboto,sans-serif;box-shadow:0 12px 34px rgba(10,25,40,.4);display:flex;gap:12px;align-items:center;max-width:92vw}' +
    '.dlk-toast a{color:#8fd3e0;font-weight:600;text-decoration:none;white-space:nowrap}' +
    '.dsr-adddeal{border:1px solid var(--accent,#2d6e7e);background:none;color:var(--accent,#2d6e7e);border-radius:9px;padding:6px 12px;font:600 12.5px system-ui,Segoe UI,Roboto,sans-serif;cursor:pointer;margin-right:10px}' +
    '.dsr-adddeal:hover{background:rgba(45,110,126,.08)}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  /* ---------- helpers ---------- */
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function sb(){ if(!window.vantageSB) throw new Error('Sign in first — the Supabase session isn’t ready.'); return window.vantageSB; }
  async function uid(){ var r=await sb().auth.getUser(); var u=r&&r.data&&r.data.user; if(!u) throw new Error('Please sign in again.'); return u.id; }
  function dealUrl(id){ return 'deals.html?deal='+encodeURIComponent(id); }
  var STAGE_LABEL={needs:'Needs & Research',touring:'Touring',evaluating:'Evaluating Options',proposals:'Proposals',negotiation:'Negotiation',executed:'Executed',dead:'Closed'};

  var toastEl=null, toastT=null;
  function toast(html, sticky){
    if(toastEl) toastEl.remove(); clearTimeout(toastT);
    toastEl=document.createElement('div'); toastEl.className='dlk-toast'; toastEl.innerHTML=html;
    document.body.appendChild(toastEl);
    if(!sticky) toastT=setTimeout(function(){ if(toastEl){toastEl.remove(); toastEl=null;} }, 9000);
  }

  /* ---------- data (mirrors deals.html insert contracts) ---------- */
  async function createDeal(opts){
    opts=opts||{};
    var me=await uid();
    var row={ owner_id:me, client_name:(opts.clientName||'').trim()||'New client', stage:'needs' };
    if(opts.hsCompanyId!=null && opts.hsCompanyId!=='') row.hs_company_id=String(opts.hsCompanyId);
    for(var i=0;i<3;i++){
      var res=await sb().from('deals').insert(row).select().single();
      if(!res.error) return res.data;
      var m=(res.error.message||'');
      // the hs_company_id column ships in the deals session's migration — degrade gracefully until Andrew runs it
      if(row.hs_company_id!==undefined && /hs_company_id/i.test(m)){ delete row.hs_company_id; continue; }
      // pre-migration stage constraint fallback, same as deals.html newDeal
      if(row.stage!=='touring' && /check constraint|deals_stage_check|invalid input/i.test(m)){ row.stage='touring'; continue; }
      throw new Error(m||'Could not create the deal.');
    }
    throw new Error('Could not create the deal.');
  }
  async function listActiveDeals(){
    var res=await sb().from('deals').select('id,client_name,stage,created_at').neq('stage','dead').order('created_at',{ascending:false}).limit(40);
    if(res.error) throw new Error(res.error.message||'Could not load your deals.');
    return res.data||[];
  }
  async function addProperty(dealId, p){
    var res=await sb().from('deal_properties').insert({
      deal_id:dealId, building_id:p.building_id||null, name:p.name||'Building',
      address:p.address||null, status:p.status||'considering'
    }).select().single();
    if(res.error) throw new Error(res.error.message||'Could not add the building.');
    return res.data;
  }
  async function addTourStop(dealId, propertyId, buildingId, label){
    var res=await sb().from('tour_stops').insert({
      deal_id:dealId, property_id:propertyId||null, building_id:buildingId||null,
      label:label||null, status:'proposed'
    });
    if(res.error) throw new Error(res.error.message||'Could not add the tour stop.');
  }
  // remember which deal a questionnaire spawned (best-effort; intake responses jsonb)
  async function linkIntake(intake, dealId){
    try{
      var responses=Object.assign({}, intake.responses||{}, {__deal:{id:dealId, at:new Date().toISOString()}});
      await sb().from('intakes').update({responses:responses}).eq('slug',intake.slug);
      intake.responses=responses;
    }catch(e){ /* non-fatal — the deal still exists */ }
  }

  /* ---------- add-a-building modal ---------- */
  function closeModal(){ var m=document.getElementById('dlkModal'); if(m) m.remove(); }
  function openAddToDeal(building){
    if(!building || !building.name){ return; }
    closeModal();
    var wrap=document.createElement('div'); wrap.className='dlk-overlay'; wrap.id='dlkModal';
    wrap.innerHTML='<div class="dlk-box"><div class="dlk-head"><h3>Add '+esc(building.name)+' to a deal</h3><button class="dlk-x" id="dlkX">×</button></div>'+
      '<div class="dlk-body"><p class="dlk-sub">Pick the client’s deal — the building lands in its Buildings list, ready to tour.</p>'+
      '<div class="dlk-list" id="dlkList"><div class="dlk-empty">Loading your deals…</div></div>'+
      '<div class="dlk-newrow"><input id="dlkNewName" type="text" placeholder="…or start a new deal — client name"><button class="dlk-btn" id="dlkNewBtn">Start deal</button></div>'+
      '<label class="dlk-tour"><input type="checkbox" id="dlkTour" checked> Also add a proposed tour stop</label>'+
      '<div class="dlk-err" id="dlkErr"></div></div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click',function(e){ if(e.target===wrap) closeModal(); });
    document.getElementById('dlkX').onclick=closeModal;

    function fail(e){ var el=document.getElementById('dlkErr'); if(el) el.textContent=e.message||String(e); }
    async function attach(deal){
      try{
        var withTour=!!(document.getElementById('dlkTour')&&document.getElementById('dlkTour').checked);
        var prop=await addProperty(deal.id,{building_id:building.id,name:building.name,address:building.addr||building.address,status:withTour?'touring':'considering'});
        if(withTour) await addTourStop(deal.id, prop.id, building.id||null, building.name);
        closeModal();
        toast('<span><b>'+esc(building.name)+'</b> added to <b>'+esc(deal.client_name)+'</b>'+(withTour?' with a proposed tour stop':'')+'.</span><a href="'+dealUrl(deal.id)+'">Open deal →</a>');
      }catch(e){ fail(e); }
    }
    document.getElementById('dlkNewBtn').onclick=async function(){
      var name=(document.getElementById('dlkNewName').value||'').trim();
      if(!name){ fail(new Error('Give the new deal a client name.')); return; }
      this.disabled=true;
      try{ var d=await createDeal({clientName:name}); await attach(d); }
      catch(e){ this.disabled=false; fail(e); }
    };
    listActiveDeals().then(function(deals){
      var list=document.getElementById('dlkList'); if(!list) return;
      if(!deals.length){ list.innerHTML='<div class="dlk-empty">No open deals yet — start one below.</div>'; return; }
      list.innerHTML=deals.map(function(d,i){
        return '<button class="dlk-deal" data-i="'+i+'"><b>'+esc(d.client_name||'Deal')+'</b><span class="st">'+esc(STAGE_LABEL[d.stage]||d.stage||'')+'</span></button>';
      }).join('');
      [].forEach.call(list.querySelectorAll('.dlk-deal'),function(btn){
        btn.onclick=function(){ attach(deals[+btn.getAttribute('data-i')]); };
      });
    }).catch(fail);
  }

  /* ---------- questionnaire → deal ---------- */
  async function startDealFromIntake(intake, props){
    var existing=intake && intake.responses && intake.responses.__deal;
    if(existing && existing.id){
      toast('<span>This questionnaire already has a deal.</span><a href="'+dealUrl(existing.id)+'">Open deal →</a>');
      return existing.id;
    }
    var deal=await createDeal({clientName:intake.company_name});
    var added=0;
    for(var i=0;i<(props||[]).length;i++){
      try{ await addProperty(deal.id, props[i]); added++; }catch(e){ /* keep going — partial list beats none */ }
    }
    await linkIntake(intake, deal.id);
    toast('<span>Deal created for <b>'+esc(deal.client_name)+'</b>'+(added?' with its top '+added+' matched buildings':'')+'.</span><a href="'+dealUrl(deal.id)+'">Open deal →</a>', true);
    return deal.id;
  }

  /* ---------- client / tenant → deal ---------- */
  async function startPursuit(opts){
    opts=opts||{};
    var deal=await createDeal({clientName:opts.name, hsCompanyId:opts.hsCompanyId});
    if(opts.buildingName){
      try{ await addProperty(deal.id,{building_id:opts.buildingId||null,name:opts.buildingName,status:'considering'}); }catch(e){}
    }
    if(opts.navigate!==false){ location.href=dealUrl(deal.id); }
    return deal.id;
  }

  window.DealLinks={
    createDeal:createDeal, listActiveDeals:listActiveDeals, addProperty:addProperty,
    addTourStop:addTourStop, openAddToDeal:openAddToDeal,
    startDealFromIntake:startDealFromIntake, startPursuit:startPursuit, dealUrl:dealUrl
  };
})();
