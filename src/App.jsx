import React,{useEffect,useMemo,useRef,useState} from 'react';
import * as XLSX from 'xlsx';
import {LayoutDashboard,ClipboardList,Users,Wallet,Settings,Calculator,Boxes,Plus,Search,MapPin,CalendarDays,TrendingUp,LogOut,Pencil,Trash2,Download,Check,X,Menu,Save,Drum,Receipt,ArrowUpRight,UserPlus,Lock,Mail,ChevronRight,Eye,EyeOff} from 'lucide-react';
import './styles.css';
const API='/api';
const defaults=()=>({
 clubName:'Lion Dance Club',
 roles:[
  {id:'head',name:'Lion Head',rate:150},
  {id:'tail',name:'Lion Tail',rate:150},
  {id:'drum',name:'Drummer',rate:120},
  {id:'cymbals',name:'Cymbals',rate:100},
  {id:'gong',name:'Gong',rate:100},
  {id:'other',name:'Other',rate:80}
 ],
 orders:[],
 performers:[],
 utilities:[],
 purchases:[],
 expenses:[]
});
const money=n=>'RM '+Number(n||0).toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2});
const today=()=>new Date().toISOString().slice(0,10); const uid=()=>crypto.randomUUID?.()||String(Date.now()+Math.random());
function migrateData(raw){
 const data={
  ...defaults(),
  ...(raw||{})
 };

 let migratedExpenses=[
  ...(Array.isArray(data.expenses)?data.expenses:[])
 ];

 if(!data.expensesMigratedVersion){
  const existingIds=new Set(
   migratedExpenses.map(e=>e.id).filter(Boolean)
  );

  data.orders=(data.orders||[]).map(order=>{
   const oldExpenses=Array.isArray(order.expenses)
    ?order.expenses
    :[];

   oldExpenses.forEach(expense=>{
    const id=expense.id||uid();

    if(!existingIds.has(id)){
     migratedExpenses.push({
      ...expense,
      id
     });

     existingIds.add(id);
    }
   });

   const oldPrice=Number(order.price||0);
   const oldStatus=order.paymentStatus||'Pending';

   const fullyReceived=
    oldStatus==='Fully Received'||
    oldStatus==='Received';

   const partiallyReceived=
    oldStatus==='Partially received';

   return {
    ...order,

    depositAmount:
     order.depositAmount??oldPrice,

    balanceAmount:
     order.balanceAmount??0,

    depositReceivedChecked:
     order.depositReceivedChecked??(
      fullyReceived||partiallyReceived
     ),

    balanceReceivedChecked:
     order.balanceReceivedChecked??fullyReceived,

    expenses:[]
   };
  });

  data.expensesMigratedVersion=1;
 }else{
  data.orders=(data.orders||[]).map(order=>({
   ...order,
   expenses:[]
  }));
 }

 data.expenses=migratedExpenses;

 return data;
}
const csvDownload=(name,rows)=>{const body=rows.map(r=>r.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n');const a=document.createElement('a');const u=URL.createObjectURL(new Blob(['\ufeff'+body],{type:'text/csv;charset=utf-8'}));a.href=u;a.download=name;a.click();URL.revokeObjectURL(u)};

// Account-specific offline storage using IndexedDB.
const OFFLINE_DB_NAME = 'lion-dance-club-offline';

function openOfflineDB(){
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open(OFFLINE_DB_NAME,1);

  request.onupgradeneeded=()=>{
   const db=request.result;
   if(!db.objectStoreNames.contains('accounts')){
    db.createObjectStore('accounts',{keyPath:'userId'});
   }
  };

  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
 });
}

async function readOfflineAccount(userId){
 const db=await openOfflineDB();

 return new Promise((resolve,reject)=>{
  const tx=db.transaction('accounts','readonly');
  const request=tx.objectStore('accounts').get(String(userId));

  request.onsuccess=()=>resolve(request.result||null);
  request.onerror=()=>reject(request.error);
  tx.oncomplete=()=>db.close();
 });
}

async function saveOfflineAccount(userId,user,data,pending,version=0){
 const db=await openOfflineDB();

 return new Promise((resolve,reject)=>{
  const tx=db.transaction('accounts','readwrite');

  tx.objectStore('accounts').put({
   userId:String(userId),
   user,
   data,
   pending:Boolean(pending),
   version:Number(version||0),
   updatedAt:Date.now()
  });

  tx.oncomplete=()=>{
   db.close();
   resolve();
  };

  tx.onerror=()=>{
   db.close();
   reject(tx.error);
  };

  tx.onabort=()=>{
   db.close();
   reject(tx.error);
  };
 });
}

function getTokenPayload(token){
 try{
  const part=token.split('.')[1];
  const base64=part.replace(/-/g,'+').replace(/_/g,'/');
  const binary=atob(base64.padEnd(Math.ceil(base64.length/4)*4,'='));
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
 }catch{
  return null;
 }
}

function App(){
 const [token,setToken]=useState(localStorage.getItem('ld_token')||'');
 const [user,setUser]=useState(null);
 const [authMode,setAuthMode]=useState('login');
 const [authForm,setAuthForm]=useState({name:'',email:'',password:''});
 const [authError,setAuthError]=useState('');
 const [authBusy,setAuthBusy]=useState(false);

 const [data,setData]=useState(defaults());
 const [loaded,setLoaded]=useState(false);
 const [dataVersion,setDataVersion]=useState(0);
 const [dataDirty,setDataDirty]=useState(false);
 const [syncStatus,setSyncStatus]=useState('loading');
 const latestDataRef=useRef(data);
 const syncInFlightRef=useRef(false);
 latestDataRef.current=data;
 const [page,setPage]=useState('overview');
 const [modal,setModal]=useState(null);
 const [query,setQuery]=useState('');
 const [toast,setToast]=useState('');
 const [mobile,setMobile]=useState(false);
 const [deferredPrompt,setDeferredPrompt]=useState(null);
 const [isInstalled,setIsInstalled]=useState(
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true
 );
 const [showInstallPopup,setShowInstallPopup]=useState(false);
 const [showInstallHelp,setShowInstallHelp]=useState(false);

 const api=async(path,options={})=>{
  const r=await fetch(API+path,{
   ...options,
   headers:{
    'Content-Type':'application/json',
    ...(token?{Authorization:`Bearer ${token}`} :{}),
    ...(options.headers||{})
   }
  });

  const j=await r.json().catch(()=>({}));

  if(!r.ok){
   const error=new Error(j.error||'Request failed');
   error.status=r.status;
   error.payload=j;
   throw error;
  }

  return j;
 };

 useEffect(()=>{
  const handleInstallPrompt=event=>{
   event.preventDefault();
   setDeferredPrompt(event);
  };

  const handleInstalled=()=>{
   setIsInstalled(true);
   setDeferredPrompt(null);
  };

  window.addEventListener('beforeinstallprompt',handleInstallPrompt);
  window.addEventListener('appinstalled',handleInstalled);

  return()=>{
   window.removeEventListener('beforeinstallprompt',handleInstallPrompt);
   window.removeEventListener('appinstalled',handleInstalled);
  };
 },[]);

 useEffect(()=>{
  if(isInstalled)return;

  const dismissedUntil=Number(
   localStorage.getItem('ld_install_prompt_dismissed_until')||0
  );

  if(dismissedUntil>Date.now())return;

  const timer=setTimeout(()=>{
   setShowInstallPopup(true);
  },3000);

  return()=>clearTimeout(timer);
 },[isInstalled]);

 const installApp=async()=>{
  if(isInstalled)return;

  if(deferredPrompt){
   try{
    await deferredPrompt.prompt();
    const choice=await deferredPrompt.userChoice;

    if(choice.outcome==='accepted'){
     setIsInstalled(true);
    }

    setDeferredPrompt(null);
    setShowInstallPopup(false);
   }catch(error){
    console.error('Installation error:',error);
   }

   return;
  }

  setShowInstallHelp(true);
 };
 useEffect(()=>{
  if(!token){
   setLoaded(true);
   setDataDirty(false);
   setSyncStatus('synced');
   return;
  }

  let live=true;

  (async()=>{
   const payload=getTokenPayload(token);
   const accountId=payload?.id;

   try{
    const cached=accountId ? await readOfflineAccount(accountId) : null;

    const [me,remote]=await Promise.all([
     api('/auth/me'),
     api('/data')
    ]);

    if(!live)return;

    if(cached?.pending){
     try{
      const localData=migrateData(cached.data);

      const saved=await api('/data',{
       method:'PUT',
       body:JSON.stringify({
        data:localData,
        expectedVersion:Number(cached.version||0)
       })
      });

      if(!live)return;

      setUser(me.user);
      setData(localData);
      setDataVersion(saved.version);
      setDataDirty(false);
      setSyncStatus('synced');

      await saveOfflineAccount(
       me.user.id,me.user,localData,false,saved.version
      );

      notify('Your offline changes have been synchronized.');
     }catch(error){
      if(!live)return;

      if(error.status===409){
       const localData=migrateData(cached.data);

       setUser(me.user);
       setData(localData);
       setDataVersion(Number(cached.version||0));
       setDataDirty(false);
       setSyncStatus('conflict');

       notify('Sync conflict: your offline changes are preserved locally.');
      }else{
       throw error;
      }
     }
    }else{
     const remoteData=migrateData(remote.data);

     setUser(me.user);
     setData(remoteData);
     setDataVersion(Number(remote.version||0));
     setDataDirty(false);
     setSyncStatus('synced');

     await saveOfflineAccount(
      me.user.id,me.user,remoteData,false,Number(remote.version||0)
     );
    }

    if(live)setLoaded(true);
   }catch(error){
    if(!live)return;

    if(error.status===401){
     localStorage.removeItem('ld_token');
     setToken('');
     setUser(null);
     setLoaded(true);
     setSyncStatus('synced');
     notify('Please log in again.');
     return;
    }

    if(accountId){
     try{
      const cached=await readOfflineAccount(accountId);

      if(cached){
       setUser(cached.user);
       setData(migrateData(cached.data));
       setDataVersion(Number(cached.version||0));
       setDataDirty(false);
       setSyncStatus(cached.pending?'offline-pending':'offline');
       setLoaded(true);

       notify('Offline mode: using saved account data.');
       return;
      }
     }catch(storageError){
      console.error('Offline storage error:',storageError);
     }
    }

    setLoaded(true);
    setSyncStatus('offline');
    notify('Unable to connect. Connect to the internet to load this account.');
   }
  })();

  return()=>{live=false};
 },[token]);

 useEffect(()=>{
  if(!token||!loaded||!user||!dataDirty)return;

  const t=setTimeout(async()=>{
   const snapshot=JSON.stringify(data);

   try{
    await saveOfflineAccount(
     user.id,user,data,true,dataVersion
    );

    if(!navigator.onLine){
     setSyncStatus('offline-pending');
     setDataDirty(false);
     return;
    }

    if(syncInFlightRef.current)return;

    syncInFlightRef.current=true;

    try{
     const saved=await api('/data',{
      method:'PUT',
      body:JSON.stringify({
       data,
       expectedVersion:dataVersion
      })
     });

     setDataVersion(saved.version);

     await saveOfflineAccount(
      user.id,user,data,false,saved.version
     );

     const latestSnapshot=JSON.stringify(latestDataRef.current);

     if(latestSnapshot!==snapshot){
      await saveOfflineAccount(
       user.id,user,latestDataRef.current,true,saved.version
      );
      setDataDirty(true);
     }else{
      setDataDirty(false);
     }

     setSyncStatus('synced');
    }catch(error){
     if(error.status===409){
      setSyncStatus('conflict');
      setDataDirty(false);
      notify('Sync conflict: local changes are preserved. Do not clear this browser data.');
     }else{
      setSyncStatus('offline-pending');
      setDataDirty(false);
      notify('Changes saved locally. Waiting for an internet connection.');
     }
    }finally{
     syncInFlightRef.current=false;
    }
   }catch(error){
    console.error('Offline save error:',error);
    setSyncStatus('offline-pending');
    setDataDirty(false);
    notify('Could not save offline data. Please check browser storage.');
   }
  },700);

  return()=>clearTimeout(t);
 },[data,dataDirty,token,loaded,user,dataVersion]);

 useEffect(()=>{
  const handleOnline=()=>{
   if(syncStatus==='offline-pending'){
    setDataDirty(true);
   }else if(syncStatus==='offline'){
    setSyncStatus('synced');
   }
  };

  window.addEventListener('online',handleOnline);
  return()=>window.removeEventListener('online',handleOnline);
 },[syncStatus]);

 useEffect(()=>{
  if(!toast)return;

  const t=setTimeout(()=>setToast(''),2800);

  return()=>clearTimeout(t);
 },[toast]);

 function notify(s){
  setToast(s);
 }

 async function submitAuth(e){
  e.preventDefault();
  setAuthBusy(true);
  setAuthError('');

  try{
   const result=await api('/auth/'+authMode,{
    method:'POST',
    body:JSON.stringify(authForm)
   });

   localStorage.setItem('ld_token',result.token);
   setUser(result.user);
   setToken(result.token);
   setLoaded(false);
  }catch(e){
   setAuthError(e.message);
  }finally{
   setAuthBusy(false);
  }
 }

 function logout(){
  localStorage.removeItem('ld_token');
  setToken('');
  setUser(null);
  setData(defaults());
  setDataDirty(false);
  setDataVersion(0);
  setSyncStatus('synced');
  setLoaded(true);
  setPage('overview');
 }

 const update=patch=>{
  setData(d=>({...d,...patch}));
  setDataDirty(true);
 };

 const orders=data.orders||[];
 const performers=data.performers||[];
 const roles=data.roles||[];

 const income=orders.reduce(
  (s,o)=>s+Number(o.price||0)+Number(o.extra||0),0
 );

 const expenses=(data.expenses||[]).reduce(
 (sum,expense)=>sum+Number(expense.amount||0),
 0
 );

 const salary=orders.reduce(
  (s,o)=>s+(o.assignments||[]).reduce(
   (a,p)=>a+Number(p.salary||0),0
  ),0
 );

 const memberCommission=orders.reduce((sum,o)=>{
  const commissionTotal=Array.isArray(o.commissionAssignments)
   ?o.commissionAssignments.reduce((total,c)=>total+Number(
     c.commission??(
      Number(o.price||0)*Number(c.commissionRate||0)/100
     )
    ),0)
   :(o.assignments||[]).reduce((total,p)=>total+Number(
     p.commission??(
      Number(o.price||0)*Number(p.commissionRate||0)/100
     )
    ),0);
  return sum+commissionTotal;
 },0);

 const memberClaims=orders.reduce(
  (s,o)=>s+(o.assignments||[]).reduce(
   (a,p)=>a+(p.claims||[]).reduce(
    (b,c)=>b+Number(c.amount||0),0
   ),0
  ),0
 );

 const memberAdditionalPay=orders.reduce(
  (s,o)=>s+(o.assignments||[]).reduce(
   (a,p)=>a+Number(p.additionalPay||0),0
  ),0
 );

 const legacyCommission=orders.reduce(
  (s,o)=>s+(o.commissionMode==='members'?0:Number(o.commission||0)),
  0
 );

 const net=
  income-
  expenses-
  salary-
  memberCommission-
  memberClaims-
  memberAdditionalPay-
  legacyCommission;

 const nav=[
  ['overview','Overview',LayoutDashboard],
  ['orders','Events',ClipboardList],
  ['performers','Members',Users],
  ['salary','Payment',Wallet],
  ['utilities','Utilities',Boxes],
  ['settings','Settings',Settings]
 ];

 if(!token||!user){
  return <Auth
   mode={authMode}
   setMode={setAuthMode}
   form={authForm}
   setForm={setAuthForm}
   submit={submitAuth}
   error={authError}
   busy={authBusy}
  />;
 }

 if(!loaded){
  return <div className="loading-screen">Loading your club records…</div>;
 }

 const openOrder=o=>setModal({type:'detail',order:o});

 const saveOrder=o=>{
  update({
   orders:o.id&&orders.some(x=>x.id===o.id)
    ?orders.map(x=>x.id===o.id?o:x)
    :[o,...orders]
  });

  setModal(null);
  notify('Event saved');
 };

 const deleteOrder=id=>{
  if(confirm('Delete this event and its linked finance records?')){
   update({orders:orders.filter(o=>o.id!==id)});
   notify('Event deleted');
  }
 };

 const exportOrders=()=>{
  const rows=[
   [
    'Event ID',
    'Event',
    'Date',
    'Time',
    'Status',
    'Location',
    'Deposit',
    'Balance',
    'Total Amount',
    'Extra Income',
    'Member salary',
    'Member commission',
    'Member additional pay',
    'Member claims',
    'Legacy commission',
    'Net'
   ],
   ...orders.map(o=>{
    const assignments=o.assignments||[];

    const memberSalary=assignments.reduce(
     (s,p)=>s+Number(p.salary||0),0
    );

    const commissionRecords=Array.isArray(o.commissionAssignments)
     ?o.commissionAssignments
     :assignments;

    const commission=commissionRecords.reduce(
     (total,c)=>total+Number(
      c.commission??(
       Number(o.price||0)*Number(c.commissionRate||0)/100
      )
     ),0
    );

    const additionalPay=assignments.reduce(
     (s,p)=>s+Number(p.additionalPay||0),0
    );

    const claims=assignments.reduce(
     (s,p)=>s+(p.claims||[]).reduce(
      (a,c)=>a+Number(c.amount||0),0
     ),0
    );

    const legacy=o.commissionMode==='members'
     ?0
     :Number(o.commission||0);

    const deposit=Number(o.depositAmount??o.price??0);
    const balance=Number(o.balanceAmount||0);
    const totalAmount=deposit+balance;
    const extraIncome=Number(o.extra||0);
    const eventIncome=totalAmount+extraIncome;

    const dateText=String(o.date||'');
    const dateMatch=dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const excelDate=dateMatch
     ?new Date(
       Number(dateMatch[1]),
       Number(dateMatch[2])-1,
       Number(dateMatch[3])
      )
     :'';

    return [
     o.orderNo||'',
     o.event||'',
     excelDate,
     o.time||'',
     o.status||'',
     o.location||'',
     deposit,
     balance,
     totalAmount,
     extraIncome,
     memberSalary,
     commission,
     additionalPay,
     claims,
     legacy,
     eventIncome-memberSalary-commission-additionalPay-claims-legacy
    ];
   })
  ];

  const worksheet=XLSX.utils.aoa_to_sheet(rows);

  worksheet['!cols']=[
   {wch:16},
   {wch:28},
   {wch:14},
   {wch:12},
   {wch:14},
   {wch:24},
   {wch:15},
   {wch:15},
   {wch:16},
   {wch:15},
   {wch:17},
   {wch:20},
   {wch:23},
   {wch:18},
   {wch:18},
   {wch:16}
  ];

  // Format event dates and financial amounts.
  for(let row=1;row<rows.length;row++){
   const dateCell=worksheet[XLSX.utils.encode_cell({r:row,c:2})];

   if(dateCell&&dateCell.v instanceof Date){
    dateCell.z='dd/mm/yyyy';
   }

   for(const col of [6,7,8,9,10,11,12,13,14,15]){
    const cell=worksheet[XLSX.utils.encode_cell({r:row,c:col})];

    if(cell&&typeof cell.v==='number'){
     cell.z='"RM" #,##0.00';
    }
   }
  }

  worksheet['!autofilter']={
   ref:XLSX.utils.encode_range({
    s:{r:0,c:0},
    e:{r:Math.max(rows.length-1,0),c:15}
   })
  };

  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,worksheet,'Events');

  XLSX.writeFile(workbook,'lion-dance-events.xlsx');
 };

 const addPerson=name=>{
  if(!name?.trim())return null;

  const found=performers.find(
   p=>p.name.toLowerCase()===name.trim().toLowerCase()
  );

  if(found)return found;

  const p={
   id:uid(),
   name:name.trim(),
   availableRoles:[]
  };

  update({performers:[...performers,p]});

  return p;
 };

 return <div className="shell">
  <aside className={`sidebar ${mobile?'show':''}`}>
   <div className="brand">
    <div className="brand-icon"><img src="/lion-sync.svg" alt="LionSync logo"/></div>
    <div>
     <b>LionSync</b>
     <small>CLUB MANAGEMENT</small>
    </div>
   </div>

   <div className="nav-caption">WORKSPACE</div>

   {nav.map(([id,label,Icon])=>
    <button
     key={id}
     className={'nav-link '+(page===id?'active':'')}
     onClick={()=>{
      setPage(id);
      setMobile(false);
     }}
    >
     <Icon size={18}/>
     {label}
     {id==='orders'&&<span className="nav-count">{orders.length}</span>}
    </button>
   )}

   <div className="sidebar-user">
    <button
     type="button"
     className="user-profile-button"
     onClick={()=>{
      setPage('account');
      setMobile(false);
     }}
    >
     <div className="avatar">{user.name?.[0]?.toUpperCase()}</div>

     <div className="user-meta">
      <b>{user.name}</b>
      <small>{user.email}</small>
     </div>
    </button>

    <button
     className="icon-button"
     title="Log out"
     onClick={logout}
    >
     <LogOut size={17}/>
    </button>
   </div>
  </aside>

  <main className="main">
   <header className="topbar">
    <button
     className="icon-button mobile-toggle"
     onClick={()=>setMobile(!mobile)}
    >
     <Menu/>
    </button>

    <div className="breadcrumb">
     Workspace <span>/</span> {nav.find(x=>x[0]===page)?.[1]||(
      page==='account'?'Account':''
     )}
    </div>

    <div className={`sync-label sync-${syncStatus}`}>
     <span className="sync-dot"/>
     {syncStatus==='loading'&&'Loading account data…'}
     {syncStatus==='synced'&&'All changes synced'}
     {syncStatus==='offline'&&'Offline · Saved account data'}
     {syncStatus==='offline-pending'&&'Offline · Changes saved locally'}
     {syncStatus==='conflict'&&'Sync conflict · Local changes preserved'}
    </div>
   </header>

   <div className="content">
    {page==='overview'&&
     <Overview
      data={data}
      orders={orders}
      performers={performers}
      income={income}
      net={net}
      setPage={setPage}
      newOrder={()=>setModal({type:'order'})}
      openOrder={openOrder}
     />
    }

    {page==='orders'&&
     <Orders
      orders={orders}
      query={query}
      setQuery={setQuery}
      openOrder={openOrder}
      editOrder={o=>setModal({type:'order',order:o})}
      deleteOrder={deleteOrder}
      newOrder={()=>setModal({type:'order'})}
      exportOrders={exportOrders}
     />
    }

    {page==='performers'&&
     <Performers
      performers={performers}
      orders={orders}
      roles={roles}
      addPerson={addPerson}
      update={update}
      notify={notify}
     />
    }

    {page==='salary'&&
     <Salary
      orders={orders}
      data={data}
      update={update}
      notify={notify}
     />
    }

    {page==='utilities'&&
     <Utilities
      data={data}
      update={update}
      notify={notify}
     />
    }

    {page==='settings'&&
     <SettingsPage
      data={data}
      update={update}
      notify={notify}
     />
    }

    {page==='account'&&
     <Account
      user={user}
      setUser={setUser}
      api={api}
      logout={logout}
      notify={notify}
     />
    }
   </div>
  </main>

  {modal?.type==='order'&&
   <OrderEditor
    order={modal.order}
    performers={performers}
    roles={roles}
    onClose={()=>setModal(null)}
    onAddPerson={addPerson}
    onSave={saveOrder}
   />
  }

  {modal?.type==='detail'&&
   <EventDetails
    order={modal.order}
    roles={roles}
    onClose={()=>setModal(null)}
    onEdit={()=>setModal({type:'order',order:modal.order})}
   />
  }

  {showInstallPopup&&!isInstalled&&
   <div className="install-overlay">
    <div className="install-popup">
     <button
      type="button"
      className="install-close"
      onClick={()=>{
       setShowInstallPopup(false);
       setShowInstallHelp(false);
       localStorage.setItem(
        'ld_install_prompt_dismissed_until',
        String(Date.now()+7*24*60*60*1000)
       );
      }}
      aria-label="Close installation popup"
     >
      ×
     </button>

     <div className="install-popup-icon">
      <Download size={30}/>
     </div>

     <h2>Install LionSync</h2>

     <p>
      Add LionSync to your device for quicker access
      and a convenient app-like experience.
     </p>

     {deferredPrompt ? (
      <button
       type="button"
       className="install-primary"
       onClick={installApp}
      >
       <Download size={17}/>
       Install Now
      </button>
     ) : (
      <>
       {showInstallHelp ? (
        <div className="install-instructions">
         {/iphone|ipad|ipod/i.test(navigator.userAgent) ||
          (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1) ? (
          <>
           <b>Install on iPhone or iPad</b>
           <ol>
            <li>Open this website in Safari.</li>
            <li>Tap the Share button.</li>
            <li>Select Add to Home Screen.</li>
            <li>Tap Add.</li>
           </ol>
          </>
         ) : (
          <>
           <b>Install on your device</b>
           <ol>
            <li>Open your browser menu.</li>
            <li>Select Install app or Add to Home screen.</li>
            <li>Follow the installation instructions.</li>
           </ol>
          </>
         )}
        </div>
       ) : (
        <button
         type="button"
         className="install-primary"
         onClick={()=>setShowInstallHelp(true)}
        >
         How to Install
        </button>
       )}
      </>
     )}

     <button
      type="button"
      className="install-later"
      onClick={()=>{
       setShowInstallPopup(false);
       setShowInstallHelp(false);
       localStorage.setItem(
        'ld_install_prompt_dismissed_until',
        String(Date.now()+7*24*60*60*1000)
       );
      }}
     >
      Maybe Later
     </button>
    </div>
   </div>
  }

  {toast&&
   <div className="toast">
    <Check size={16}/>{toast}
   </div>
  }
 </div>;
}
function Account({user,setUser,api,logout,notify}){
 const [username,setUsername]=useState(user.name||'');
 const [committeeRole,setCommitteeRole]=useState(user.committeeRole||'Member');
 const [password,setPassword]=useState('');
 const [savingName,setSavingName]=useState(false);
 const [savingRole,setSavingRole]=useState(false);
 const [deleting,setDeleting]=useState(false);

 const committeeRoles=[
  'President','Vice President','Secretary','Treasurer',
  'Committee Member','Member','Other'
 ];

 async function saveUsername(){
  const cleanUsername=username.trim();

  if(!cleanUsername){
   notify('Please enter a username');
   return;
  }

  if(cleanUsername.length>60){
   notify('Username must not exceed 60 characters');
   return;
  }

  setSavingName(true);
  try{
   const result=await api('/auth/account',{
    method:'PUT',
    body:JSON.stringify({name:cleanUsername})
   });

   setUser(result.user||{...user,name:cleanUsername});
   setUsername(cleanUsername);
   notify('Username updated successfully');
  }catch(e){
   notify(e.message);
  }finally{
   setSavingName(false);
  }
 }

 async function saveRole(){
  setSavingRole(true);
  try{
   const result=await api('/auth/account',{
    method:'PUT',
    body:JSON.stringify({committeeRole})
   });

   setUser(result.user||{...user,committeeRole});
   notify('Committee role updated');
  }catch(e){
   notify(e.message);
  }finally{
   setSavingRole(false);
  }
 }

 async function deleteAccount(){
  if(!password){
   notify('Please enter your password');
   return;
  }

  if(!confirm(
   'Permanently delete your account and all club records belonging to this account? This cannot be undone.'
  )){
   return;
  }

  setDeleting(true);
  try{
   await api('/auth/account',{
    method:'DELETE',
    body:JSON.stringify({password})
   });

   alert('Your account has been deleted.');
   logout();
  }catch(e){
   notify(e.message);
   setDeleting(false);
  }
 }

 return <>
  <Heading
   eyebrow="PERSONAL SETTINGS"
   title="Account"
   desc="Manage your username, account information and committee position."
  />

  <div className="two-col">
   <Panel title="Account information" desc="View and update your account details">
    <div className="purchase-form">
     <label className="field-group">
      <span>Username</span>
      <input
       className="field"
       type="text"
       maxLength="60"
       value={username}
       onChange={e=>setUsername(e.target.value)}
       placeholder="Enter your username"
      />
     </label>

     <button
      className="btn primary"
      onClick={saveUsername}
      disabled={savingName}
     >
      <Save size={16}/>
      {savingName?'Saving…':'Save username'}
     </button>
    </div>

    <div className="glance account-details">
     <div>
      <span>Email address</span>
      <b>{user.email}</b>
     </div>
     <div>
      <span>Committee position</span>
      <b>{user.committeeRole||'Member'}</b>
     </div>
    </div>
   </Panel>

   <Panel title="Committee position" desc="Set your current position in the club">
    <div className="purchase-form">
     <label className="field-group">
      <span>Committee role</span>
      <select
       className="field"
       value={committeeRole}
       onChange={e=>setCommitteeRole(e.target.value)}
      >
       {committeeRoles.map(role=>
        <option key={role} value={role}>{role}</option>
       )}
      </select>
     </label>

     <button
      className="btn primary"
      onClick={saveRole}
      disabled={savingRole}
     >
      <Save size={16}/>
      {savingRole?'Saving…':'Save position'}
     </button>
    </div>
   </Panel>
  </div>

  <Panel
   title="Delete account"
   desc="Permanently delete your account and all club records stored under it."
  >
   <div className="purchase-form">
    <label className="field-group">
     <span>Confirm your password</span>
     <input
      className="field"
      type="password"
      value={password}
      onChange={e=>setPassword(e.target.value)}
      placeholder="Enter your account password"
     />
    </label>

    <div>
     <button
      className="btn danger"
      onClick={deleteAccount}
      disabled={deleting}
     >
      <Trash2 size={16}/>
      {deleting?'Deleting…':'Permanently delete account'}
     </button>
    </div>
   </div>
  </Panel>
 </>;
}

function Auth({mode,setMode,form,setForm,submit,error,busy}){
 const [showPassword,setShowPassword]=useState(false);

 return <div className="auth-page">
  <div className="auth-art">
   <div className="auth-brand">
    <div className="brand-icon">
     <img src="/lion-sync.svg" alt="LionSync logo"/>
    </div>
    <span>LIONSYNC</span>
   </div>

   <div className="auth-copy">
    <div className="eyebrow">YOUR CLUB, ORGANIZED</div>
    <h1>Every performance.<br/>Every detail.<br/><em>One place.</em></h1>
    <p>Manage bookings, members, payroll and club finances with records tied to your account.</p>
   </div>

   <div className="auth-foot">Secure account-based club management</div>
  </div>

  <div className="auth-panel">
   <form className="auth-card" onSubmit={submit}>
    <div className="auth-symbol"><Lock/></div>
    <div className="eyebrow">WELCOME</div>
    <h2>{mode==='login'?'Sign in to LionSync':'Create your LionSync account'}</h2>
    <p>{mode==='login'?'Access your club records from any device.':'Start managing your lion dance club records.'}</p>

    {mode==='register'&&
     <label>
      Username
      <input
       required
       maxLength="60"
       value={form.name}
       onChange={e=>setForm({...form,name:e.target.value})}
       placeholder="Choose a username"
      />
     </label>
    }

    <label>
     Email address
     <input
      required
      type="email"
      value={form.email}
      onChange={e=>setForm({...form,email:e.target.value})}
      placeholder="name@example.com"
     />
    </label>

    <label className="auth-password-field">
     <span>Password</span>
     <div className="password-input-wrap">
      <input
       required
       minLength="8"
       type={showPassword?'text':'password'}
       value={form.password}
       onChange={e=>setForm({...form,password:e.target.value})}
       placeholder="At least 8 characters"
       autoComplete={mode==='login'?'current-password':'new-password'}
      />
      <button
       type="button"
       className="password-toggle"
       onClick={()=>setShowPassword(value=>!value)}
       aria-label={showPassword?'Hide password':'Show password'}
       title={showPassword?'Hide password':'Show password'}
      >
       {showPassword?<EyeOff size={18}/>:<Eye size={18}/>}
      </button>
     </div>
    </label>

    {error&&<div className="error-box">{error}</div>}

    <button className="btn primary full" disabled={busy}>
     {busy?'Please wait…':mode==='login'?'Sign in':'Create account'}
    </button>

    <div className="auth-switch">
     {mode==='login'?"Don't have an account?":"Already have an account?"}
     {' '}
     <button
      type="button"
      onClick={()=>{
       setShowPassword(false);
       setMode(mode==='login'?'register':'login');
      }}
     >
      {mode==='login'?'Register':'Sign in'}
     </button>
    </div>
   </form>
  </div>
 </div>;
}

function Heading({eyebrow,title,desc,action}){return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{desc}</p></div>{action}</div>}
function Stat({label,value,sub,icon:Icon,tone=''}){return <div className="stat-card"><div className={'stat-icon '+tone}><Icon size={19}/></div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-sub">{sub}</div></div>}
function Panel({title,desc,children,action}){return <section className="panel"><div className="panel-head"><div><h3>{title}</h3>{desc&&<p>{desc}</p>}</div>{action}</div>{children}</section>}
function Empty({title,desc}){return <div className="empty"><div className="empty-icon"><Receipt/></div><b>{title}</b><p>{desc}</p></div>}
function Overview({data,orders,performers,income,net,setPage,newOrder,openOrder}){
 const pending=orders.filter(o=>o.status!=='past');
 const past=orders.filter(o=>o.status==='past');

 const upcoming=[...pending]
  .sort((a,b)=>(a.date||'').localeCompare(b.date||''))
  .slice(0,5);

 return <>
  <Heading
   eyebrow="CLUB SNAPSHOT"
   title="Overview"
   desc="A quick view of bookings and club finances."
   action={
    <button className="btn primary" onClick={newOrder}>
     <Plus size={17}/> Add event
    </button>
   }
  />

  <div className="stats-grid">
   <Stat
    label="Total events"
    value={orders.length}
    sub={`${pending.length} pending · ${past.length} past`}
    icon={ClipboardList}
   />

   <Stat
    label="Total income"
    value={money(income)}
    sub="Event total amounts + extra income"
    icon={TrendingUp}
    tone="gold"
   />

   <Stat
    label="Net earnings"
    value={money(net)}
    sub="After commission, salaries and expenses"
    icon={Wallet}
    tone="green"
   />

   <Stat
    label="Members"
    value={performers.length}
    sub="Registered club members"
    icon={Users}
    tone="blue"
   />
  </div>

  <div className="two-col">
   <Panel title="Upcoming events" desc="Pending performances">
    <div className="simple-list">
     {upcoming.length?upcoming.map(o=>
      <button
       className="list-row clickable"
       key={o.id}
       onClick={()=>openOrder(o)}
      >
       <div className="date-chip">
        <b>{o.date?.slice(8,10)||'--'}</b>
        <small>{o.date?.slice(5,7)||'--'}</small>
       </div>

       <div className="list-main">
        <b>{o.event}</b>
        <small>
         <MapPin size={12}/>{o.location}{o.time?` · ${o.time}`:''}
        </small>
       </div>

       <strong>{money(o.price)}</strong>

       <ChevronRight size={16}/>
      </button>
     ):<Empty
      title="No pending events"
      desc="New bookings will appear here."
     />}
    </div>
   </Panel>

   <Panel title="Club at a glance" desc="Your current records">
    <div className="glance">
     <div>
      <span>Pending events</span>
      <b>{pending.length}</b>
     </div>

     <div>
      <span>Past events</span>
      <b>{past.length}</b>
     </div>

     <div>
      <span>Utilities tracked</span>
      <b>{data.utilities?.length||0}</b>
     </div>
    </div>

    <button
     className="btn outline full"
     onClick={()=>setPage('salary')}
    >
     Open Payment page <ArrowUpRight size={16}/>
    </button>
   </Panel>
  </div>
 </>;
}
function Orders({orders,query,setQuery,openOrder,editOrder,deleteOrder,newOrder,exportOrders}){const [tab,setTab]=useState('pending');const [month,setMonth]=useState('');const filtered=orders.filter(o=>(tab==='past'?o.status==='past':o.status!=='past')&&(`${o.orderNo} ${o.event} ${o.location}`.toLowerCase().includes(query.toLowerCase()))&&(!month||o.date?.startsWith(month))).sort((a,b)=>(b.date||'').localeCompare(a.date||''));return <><Heading eyebrow="BOOKING RECORDS" title="Events" desc="Track upcoming and completed lion dance performances." action={<button className="btn primary" onClick={newOrder}><Plus size={17}/> Add event</button>}/><div className="toolbar"><div className="tabs"><button className={tab==='pending'?'selected':''} onClick={()=>setTab('pending')}>Pending <span>{orders.filter(o=>o.status!=='past').length}</span></button><button className={tab==='past'?'selected':''} onClick={()=>setTab('past')}>Past <span>{orders.filter(o=>o.status==='past').length}</span></button></div><div className="searchbox"><Search size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search event…"/></div><input className="field month-field" type="month" value={month} onChange={e=>setMonth(e.target.value)}/><button className="btn outline" onClick={exportOrders}><Download size={16}/> Export</button></div><Panel title={`${tab==='pending'?'Pending':'Past'} events`} desc="Select an event name to view its full record."><div className="table-wrap"><table><thead><tr><th>EVENT NAME</th><th>DATE</th><th>LOCATION</th><th>TOTAL AMOUNT</th><th>MEMBERS</th><th>PAYMENT</th><th/></tr></thead><tbody>{filtered.map(o=><tr key={o.id}><td><button className="event-link" onClick={()=>openOrder(o)}>{o.event||'Untitled event'}</button><small>{o.orderNo}</small></td><td>{o.date}{o.time&&<small>{o.time}</small>}</td><td>{o.location}</td><td><div className="event-amount"><strong>{money(o.price)}</strong><small>Extra income: {money(o.extra)}</small></div></td><td>{o.assignments?.length||0}</td><td><span className={'status '+(o.paymentStatus==='Fully Received'?'payment-good':o.paymentStatus==='Partially received'?'payment-partial':'payment-pending')}>{o.paymentStatus||'Pending'}</span></td><td><div className="row-actions"><button className="icon-button" title="Edit" onClick={()=>editOrder(o)}><Pencil size={15}/></button><button className="icon-button danger" title="Delete" onClick={()=>deleteOrder(o.id)}><Trash2 size={15}/></button></div></td></tr>)}</tbody></table>{!filtered.length&&<Empty title={`No ${tab} events`} desc="Add an event or change your search filters."/>}</div></Panel></>}
function OrderEditor({order,performers,roles,onClose,onAddPerson,onSave}){
 const [f,setF]=useState(()=>{
  const price=Number(order?.price||0);
  const extra=Number(order?.extra||0);

  const oldCommissionAssignments=order?.assignments||[];

  const commissionAssignments=Array.isArray(order?.commissionAssignments)
   ?order.commissionAssignments
   :oldCommissionAssignments
    .filter(a=>
     Number(a.commissionRate||0)>0||
     Number(a.commission||0)>0
    )
    .map(a=>({
     id:uid(),
     performerId:a.performerId,
     name:a.name,
     commissionRate:a.commissionRate??(
      price>0?Number(a.commission||0)/price*100:0
     ),
     commission:a.commission||0,
     paid:Boolean(a.commissionPaid??a.paid),
     paidDate:a.commissionPaidDate||a.paidDate||''
    }));

  return {
   ...(order||{}),
   id:order?.id||uid(),
   orderNo:order?.orderNo||'LD-'+Date.now().toString().slice(-6),
   event:order?.event||'',
   date:order?.date||today(),
   time:order?.time||'',
   location:order?.location||'',
   customer:order?.customer||'',
   price:order?.price??'',
   depositAmount:order?.depositAmount??(order?.price??''),
   balanceAmount:order?.balanceAmount??0,
   depositReceivedChecked:order
    ?Boolean(order.depositReceivedChecked)
    :false,
   balanceReceivedChecked:order
    ?Boolean(order.balanceReceivedChecked)
    :false,
   extra:order?.extra??'0',
   depositReceived:order
    ?order.depositReceived??(
      order.paymentStatus==='Received'||
      order.paymentStatus==='Fully Received'
       ?price+extra
       :order.paymentStatus==='Partially received'
        ?''
        :0
     )
    :0,
   commission:order?.commission||0,
   commissionRate:order?.commissionRate||0,
   status:order?.status||'pending',
   paymentStatus:order?.paymentStatus||'Pending',
   notes:order?.notes||'',
   assignments:(order?.assignments||[]).map(a=>({
    ...a,
    claims:a.claims||[]
   })),
   commissionAssignments,
   expenses:order?.expenses||[]
  };
 });

 const [personName,setPersonName]=useState('');
 const [selected,setSelected]=useState('');
 const [role,setRole]=useState(roles[0]?.id||'');
 const [customSalary,setCustomSalary]=useState('');

 const [commissionPersonName,setCommissionPersonName]=useState('');
 const [commissionSelected,setCommissionSelected]=useState('');
 const [commissionRate,setCommissionRate]=useState('');

 const [claimDraft,setClaimDraft]=useState({
  category:'Food',
  description:'',
  date:today(),
  amount:''
 });

 const [commissionOpen,setCommissionOpen]=useState(false);
 const [commissionDraft,setCommissionDraft]=useState([]);

 const set=(key,value)=>{
  setF(current=>({...current,[key]:value}));
 };

 function openCommission(){
  setCommissionDraft((f.commissionAssignments||[]).map(a=>({...a})));
  setCommissionOpen(true);
 }

 function closeCommission(){
  setCommissionDraft([]);
  setCommissionOpen(false);
 }

 function saveCommissionDraft(){
  const resolved=commissionDraft.map(a=>{
   if(!String(a.performerId).startsWith('draft-'))return a;

   const existing=performers.find(
    p=>(p.name||'').trim().toLowerCase()===a.name.trim().toLowerCase()
   );
   const person=existing||onAddPerson(a.name);

   if(!person)return null;

   return {...a,performerId:person.id,name:person.name};
  });

  if(resolved.some(a=>!a)){
   alert('Unable to save one of the new members. Please try again.');
   return;
  }

  const ids=resolved.map(a=>a.performerId);
  if(new Set(ids).size!==ids.length){
   alert('A member can only have one commission assignment per event.');
   return;
  }

  set('commissionAssignments',resolved);
  closeCommission();
 }

 const depositAmount=Number(f.depositAmount||0);
 const balanceAmount=Number(f.balanceAmount||0);
 const orderTotal=depositAmount+balanceAmount;
 const orderPrice=orderTotal;
 const additionalMoney=Number(f.extra||0);

 let currentPaymentStatus='Pending';

 if(f.depositReceivedChecked&&f.balanceReceivedChecked){
  currentPaymentStatus='Fully Received';
 }else if(f.depositReceivedChecked){
  currentPaymentStatus='Partially received';
 }

 const memberCommission=(f.commissionAssignments||[]).reduce(
  (sum,a)=>sum+Number(a.commission||0),
  0
 );

 const totalSalary=(f.assignments||[]).reduce(
  (sum,a)=>sum+Number(a.salary||0),
  0
 );

 const totalClaims=(f.assignments||[]).reduce(
  (sum,a)=>sum+(a.claims||[]).reduce(
   (s,c)=>s+Number(c.amount||0),0
  ),
  0
 );

 const totalAdditionalPay=(f.assignments||[]).reduce(
  (sum,a)=>sum+Number(a.additionalPay||0),
  0
 );

 function addMember(){
  let person=performers.find(p=>p.id===selected);

  if(!person&&personName.trim()){
   person=onAddPerson(personName.trim());
  }

  if(!person){
   alert('Select an existing member or enter a new name.');
   return;
  }

  if(f.assignments.some(a=>a.performerId===person.id)){
   alert('This member is already assigned to this event.');
   return;
  }

  const selectedRole=roles.find(r=>r.id===role);

  set('assignments',[
   ...f.assignments,
   {
    id:uid(),
    performerId:person.id,
    name:person.name,
    roleName:selectedRole?.name||'Other',
    salary:customSalary===''?Number(selectedRole?.rate||0):Number(customSalary),
    commissionRate:0,
    commission:0,
    additionalPay:0,
    additionalPayType:'',
    additionalPayOther:'',
    claims:[],
    paid:false
   }
  ]);

  setSelected('');
  setPersonName('');
  setCustomSalary('');
 }

 function updateAssignment(index,patch){
  set('assignments',f.assignments.map((a,i)=>
   i===index?{...a,...patch}:a
  ));
 }

 function removeMember(index){
  const assignment=f.assignments[index];

  if(assignment?.paid){
   alert('This member has a paid historical record. Keep the record inside the event.');
   return;
  }

  if(!confirm(`Remove ${assignment?.name||'this member'} from this event?`)){
   return;
  }

  set('assignments',f.assignments.filter((_,i)=>i!==index));
 }

 function addClaim(index){
  const amount=Number(claimDraft.amount);
  const assignment=f.assignments[index];

  if(!assignment){
   return;
  }

  if(!claimDraft.description.trim()){
   alert('Please enter a claim description.');
   return;
  }

  if(!claimDraft.date){
   alert('Please select the claim date.');
   return;
  }

  if(!Number.isFinite(amount)||amount<=0){
   alert('Please enter a valid claim amount.');
   return;
  }

  const claim={
   id:uid(),
   category:claimDraft.category,
   description:claimDraft.description.trim(),
   date:claimDraft.date,
   amount,
   paid:false
  };

  updateAssignment(index,{
   claims:[...(assignment.claims||[]),claim]
  });

  setClaimDraft({
   category:'Food',
   description:'',
   date:today(),
   amount:''
  });
 }

 function deleteClaim(index,claimId){
  const assignment=f.assignments[index];

  if(!assignment)return;

  updateAssignment(index,{
   claims:(assignment.claims||[]).filter(c=>c.id!==claimId)
  });
 }

 function addCommission(){
  let person=performers.find(p=>p.id===commissionSelected);
  let isDraftPerson=false;

  if(!person&&commissionPersonName.trim()){
   person={
    id:'draft-'+uid(),
    name:commissionPersonName.trim()
   };
   isDraftPerson=true;
  }

  if(!person){
   alert('Select an existing member or enter a new name.');
   return;
  }

  if(commissionDraft.some(a=>
   a.performerId===person.id||
   (isDraftPerson&&a.name.trim().toLowerCase()===person.name.trim().toLowerCase())
  )){
   alert('This member already has a commission assignment for this event.');
   return;
  }

  const rate=Number(commissionRate);

  if(commissionRate===''||!Number.isFinite(rate)||rate<0||rate>100){
   alert('Enter a commission percentage between 0 and 100.');
   return;
  }

  setCommissionDraft(current=>[
   ...current,
   {
    id:uid(),
    performerId:person.id,
    name:person.name,
    commissionRate:rate,
    commission:Number((orderPrice*rate/100).toFixed(2)),
    paid:false,
    paidDate:''
   }
  ]);

  setCommissionSelected('');
  setCommissionPersonName('');
  setCommissionRate('');
 }

 function updateCommission(index,value){
  if(value===''||!Number.isFinite(Number(value))||Number(value)<0||Number(value)>100){
   return;
  }

  const rate=Number(value);

  setCommissionDraft(current=>current.map((a,i)=>
   i===index
    ?{
      ...a,
      commissionRate:rate,
      commission:Number((orderPrice*rate/100).toFixed(2))
     }
    :a
  ));
 }

 function removeCommission(index){
  const assignment=commissionDraft[index];

  if(assignment?.paid){
   alert('This commission has a paid historical record. Keep the record inside the event.');
   return;
  }

  setCommissionDraft(current=>current.filter((a,i)=>i!==index));
 }

 function save(){
  if(!f.event.trim()||!f.date||!f.location.trim()){
   alert('Event name, date and location are required.');
   return;
  }

  if(
   !Number.isFinite(depositAmount)||depositAmount<0||
   !Number.isFinite(balanceAmount)||balanceAmount<0||
   !Number.isFinite(additionalMoney)||additionalMoney<0
  ){
   alert('Please enter valid non-negative payment amounts.');
   return;
  }

  for(const a of f.assignments){
   const additionalPay=Number(a.additionalPay||0);

   if(!Number.isFinite(additionalPay)||additionalPay<0){
    alert(`Please enter a valid additional pay amount for ${a.name||'this member'}.`);
    return;
   }

   if(additionalPay>0&&!a.additionalPayType){
    alert(`Please select what the additional pay is for ${a.name||'this member'}.`);
    return;
   }

   if(additionalPay>0&&a.additionalPayType==='Others'&&
    !String(a.additionalPayOther||'').trim()){
    alert(`Please enter the custom payment purpose for ${a.name||'this member'}.`);
    return;
   }
  }

  const assignments=f.assignments.map(a=>({
   ...a,
   salary:Number(a.salary||0),
   additionalPay:Number(a.additionalPay||0),
   additionalPayType:a.additionalPayType||'',
   additionalPayOther:String(a.additionalPayOther||'').trim(),
   claims:a.claims||[]
  }));

  const commissions=f.commissionAssignments.map(a=>({
   ...a,
   commissionRate:Number(a.commissionRate||0),
   commission:a.paid
    ?Number(a.commission||0)
    :Number((orderTotal*Number(a.commissionRate||0)/100).toFixed(2))
  }));

  onSave({
   ...f,
   assignments,
   commissionAssignments:commissions,
   depositAmount,
   balanceAmount,
   price:orderTotal,
   extra:additionalMoney,
   paymentStatus:currentPaymentStatus,
   commission:Number(f.commission||0),
   commissionRate:Number(f.commissionRate||0),
   expenses:f.expenses||[]
  });
 }

 return <>
  <Modal title={order?'Edit event':'Add event'} onClose={onClose} wide>
   <div className="form-grid">
    <Field label="Event ID">
     <input
      value={f.orderNo}
      onChange={e=>set('orderNo',e.target.value)}
     />
    </Field>

    <Field label="Event date *">
     <input
      type="date"
      value={f.date}
      onChange={e=>set('date',e.target.value)}
     />
    </Field>

    <Field label="Event time">
     <input
      type="time"
      value={f.time||''}
      onChange={e=>set('time',e.target.value)}
     />
    </Field>

    <Field label="Event name *" wide>
     <input
      value={f.event}
      onChange={e=>set('event',e.target.value)}
      placeholder="e.g. Shop opening ceremony"
     />
    </Field>

    <Field label="Location *" wide>
     <input
      value={f.location}
      onChange={e=>set('location',e.target.value)}
     />
    </Field>

    <Field label="Customer / organizer">
     <input
      value={f.customer||''}
      onChange={e=>set('customer',e.target.value)}
     />
    </Field>

    <Field label="Event status">
     <select
      value={f.status||'pending'}
      onChange={e=>set('status',e.target.value)}
     >
      <option value="pending">Pending</option>
      <option value="past">Past / completed</option>
     </select>
    </Field>

    <Field label="Deposit (RM)">
     <input
      type="number"
      min="0"
      step="0.01"
      value={f.depositAmount}
      onChange={e=>set('depositAmount',e.target.value)}
      placeholder="Enter deposit amount"
     />
    </Field>

    <Field label="Balance (RM)">
     <input
      type="number"
      min="0"
      step="0.01"
      value={f.balanceAmount}
      onChange={e=>set('balanceAmount',e.target.value)}
      placeholder="Enter balance amount"
     />
    </Field>

    <Field label="Total Amount (RM)">
     <input value={money(orderTotal)} readOnly/>
    </Field>

    <Field label="Extra Income (RM)">
     <input
      type="number"
      min="0"
      step="0.01"
      value={f.extra}
      onChange={e=>set('extra',e.target.value)}
      placeholder="Enter extra income"
     />
    </Field>

    <Field label="Deposit received">
     <label className="payment-check">
      <input
       type="checkbox"
       checked={Boolean(f.depositReceivedChecked)}
       onChange={e=>set('depositReceivedChecked',e.target.checked)}
      />
      Deposit has been received
     </label>
    </Field>

    <Field label="Balance received">
     <label className="payment-check">
      <input
       type="checkbox"
       checked={Boolean(f.balanceReceivedChecked)}
       onChange={e=>set('balanceReceivedChecked',e.target.checked)}
      />
      Balance has been received
     </label>
    </Field>

    <Field label="Payment status">
     <input value={currentPaymentStatus} readOnly/>
    </Field>

    <Field label="Notes" wide>
     <textarea
      rows="2"
      value={f.notes||''}
      onChange={e=>set('notes',e.target.value)}
     />
    </Field>
   </div>

   {order&&<>
    <div className="subsection">
     <div className="subsection-head">
      <div>
       <h3>Members & roles</h3>
       <p>
        Add performers after creating the event. Default salaries come from Settings.
       </p>
      </div>
     </div>

     <div className="assignment-add">
      <select
       value={selected}
       onChange={e=>setSelected(e.target.value)}
      >
       <option value="">Select existing member</option>
       {performers
        .filter(p=>!f.assignments.some(a=>a.performerId===p.id))
        .map(p=>
         <option key={p.id} value={p.id}>{p.name}</option>
        )}
      </select>

      <input
       placeholder="Or add new member name"
       value={personName}
       onChange={e=>setPersonName(e.target.value)}
      />

      <select
       value={role}
       onChange={e=>setRole(e.target.value)}
      >
       {roles.map(r=>
        <option key={r.id} value={r.id}>
         {r.name} · {money(r.rate)}
        </option>
       )}
      </select>

      <input
       type="number"
       min="0"
       step="0.01"
       placeholder="Salary override"
       value={customSalary}
       onChange={e=>setCustomSalary(e.target.value)}
      />

      <button className="btn outline" onClick={addMember}>
       <UserPlus size={15}/> Add member
      </button>
     </div>

     {f.assignments.map((a,i)=>
      <div className="assignment-row" key={a.id||a.performerId||i}>
       <div>
        <b>{a.name}</b>
        <small>{a.roleName}</small>
       </div>

       <label>
        Salary RM
        <input
         type="number"
         min="0"
         step="0.01"
         value={a.salary}
         onChange={e=>updateAssignment(i,{salary:e.target.value})}
        />
       </label>

       <div className="span-2 form-grid">
        <Field label="Additional pay (RM)">
         <input
          type="number"
          min="0"
          step="0.01"
          value={a.additionalPay??''}
          onChange={e=>updateAssignment(i,{additionalPay:e.target.value})}
          placeholder="0.00"
         />
        </Field>

        <Field label="Pay for">
         <select
          value={a.additionalPayType||''}
          onChange={e=>updateAssignment(i,{additionalPayType:e.target.value})}
         >
          <option value="">Select purpose</option>
          <option value="Laundry">Laundry</option>
          <option value="Food">Food</option>
          <option value="Toll">Toll</option>
          <option value="Parking">Parking</option>
          <option value="Others">Others</option>
         </select>
        </Field>

        {a.additionalPayType==='Others'&&
         <Field label="Custom purpose">
          <input
           value={a.additionalPayOther||''}
           onChange={e=>updateAssignment(i,{additionalPayOther:e.target.value})}
           placeholder="Enter payment purpose"
          />
         </Field>
        }
       </div>

       <span className={'status '+(a.paid?'good':'pending')}>
        {a.paid?'Paid':'Unpaid'}
       </span>

       <button
        className="icon-button danger"
        title="Remove member"
        onClick={()=>removeMember(i)}
       >
        <X size={16}/>
       </button>

       <div className="span-2">
        <details>
         <summary>Additional pay claims ({(a.claims||[]).length})</summary>

         {(a.claims||[]).map(c=>
          <div className="history-row" key={c.id}>
           <span>
            {c.category} · {c.description}
            <small>{c.date}</small>
           </span>
           <b>{money(c.amount)}</b>
           <button
            className="icon-button danger"
            title="Remove claim"
            onClick={()=>deleteClaim(i,c.id)}
           >
            <Trash2 size={14}/>
           </button>
          </div>
         )}

         <div className="form-grid">
          <Field label="Category">
           <select
            value={claimDraft.category}
            onChange={e=>setClaimDraft(x=>({...x,category:e.target.value}))}
           >
            <option>Food</option>
            <option>Toll</option>
            <option>Parking</option>
            <option>Transportation</option>
            <option>Equipment</option>
            <option>Medical</option>
            <option>Other</option>
           </select>
          </Field>

          <Field label="Claim date">
           <input
            type="date"
            value={claimDraft.date}
            onChange={e=>setClaimDraft(x=>({...x,date:e.target.value}))}
           />
          </Field>

          <Field label="Description">
           <input
            value={claimDraft.description}
            onChange={e=>setClaimDraft(x=>({...x,description:e.target.value}))}
            placeholder="e.g. Food after performance"
           />
          </Field>

          <Field label="Amount (RM)">
           <input
            type="number"
            min="0"
            step="0.01"
            value={claimDraft.amount}
            onChange={e=>setClaimDraft(x=>({...x,amount:e.target.value}))}
           />
          </Field>

          <button
           type="button"
           className="btn outline"
           onClick={()=>addClaim(i)}
          >
           <Plus size={15}/> Add claim
          </button>
         </div>
        </details>
       </div>
      </div>
     )}

     <div className="sub-total">
      <span>Total member salary</span>
      <b>{money(totalSalary)}</b>
     </div>

     <div className="sub-total">
      <span>Total additional pay</span>
      <b>{money(totalAdditionalPay)}</b>
     </div>

     <div className="sub-total">
      <span>Total additional pay claims</span>
      <b>{money(totalClaims)}</b>
     </div>
    </div>

    <div className="subsection">
     <div className="subsection-head">
      <div>
       <h3>Commission assignments</h3>
       <p>
        Commission can be assigned to any registered member, whether or not they perform at this event.
       </p>
      </div>

      <button
       className="btn outline"
       onClick={openCommission}
      >
       <Calculator size={15}/> Manage commission
      </button>
     </div>

     {f.commissionAssignments.length?
      f.commissionAssignments.map((a,i)=>
       <div className="assignment-row" key={a.id||a.performerId||i}>
        <div>
         <b>{a.name}</b>
         <small>{Number(a.commissionRate||0)}% commission</small>
        </div>

        <strong>{money(a.commission)}</strong>

        <span className={'status '+(a.paid?'good':'pending')}>
         {a.paid?'Paid':'Unpaid'}
        </span>

        {!a.paid&&
         <button
          className="icon-button danger"
          title="Remove commission"
          onClick={()=>removeCommission(i)}
         >
          <X size={16}/>
         </button>
        }
       </div>
      )
      :
      <p className="muted">No commission assignments yet.</p>
     }

     <div className="sub-total">
      <span>Total commission</span>
      <b>{money(memberCommission)}</b>
     </div>
    </div>
   </>}

   <div className="modal-actions">
    <button className="btn outline" onClick={onClose}>Cancel</button>
    <button className="btn primary" onClick={save}>
     <Save size={16}/> Save event
    </button>
   </div>
  </Modal>

  {commissionOpen&&order&&
   <Modal title="Manage commission assignments" onClose={closeCommission} wide>
    <p className="muted">
     Commission is calculated from Total Amount (Deposit + Balance). Extra Income is excluded.
    </p>

    <div className="detail-grid">
     <div>
      <small>Total Amount</small>
      <b>{money(orderTotal)}</b>
     </div>
     <div>
      <small>Total commission</small>
      <b>{money(commissionDraft.reduce((sum,a)=>sum+Number(a.commission||0),0))}</b>
     </div>
    </div>

    <div className="assignment-add">
     <select
      value={commissionSelected}
      onChange={e=>setCommissionSelected(e.target.value)}
     >
      <option value="">Select any registered member</option>
      {performers
       .filter(p=>!commissionDraft.some(a=>a.performerId===p.id))
       .map(p=>
        <option key={p.id} value={p.id}>{p.name}</option>
       )}
     </select>

     <input
      value={commissionPersonName}
      onChange={e=>setCommissionPersonName(e.target.value)}
      placeholder="Or add new member name"
     />

     <input
      type="number"
      min="0"
      max="100"
      step="0.01"
      value={commissionRate}
      onChange={e=>setCommissionRate(e.target.value)}
      placeholder="Commission %"
     />

     <button className="btn outline" onClick={addCommission}>
      <Plus size={15}/> Add commission
     </button>
    </div>

    <div className="table-wrap">
     <table>
      <thead>
       <tr>
        <th>MEMBER</th>
        <th>COMMISSION (%)</th>
        <th>COMMISSION (RM)</th>
        <th>STATUS</th>
        <th/>
       </tr>
      </thead>

      <tbody>
       {commissionDraft.map((a,i)=>
        <tr key={a.id||a.performerId||i}>
         <td>{a.name}</td>
         <td>
          <input
           type="number"
           min="0"
           max="100"
           step="0.01"
           value={a.commissionRate??0}
           onChange={e=>updateCommission(i,e.target.value)}
          />
         </td>
         <td>{money(orderPrice*Number(a.commissionRate||0)/100)}</td>
         <td>
          <span className={'status '+(a.paid?'good':'pending')}>
           {a.paid?'Paid':'Unpaid'}
          </span>
         </td>
         <td>
          {!a.paid&&
           <button
            className="icon-button danger"
            onClick={()=>removeCommission(i)}
            title="Remove commission"
           >
            <Trash2 size={14}/>
           </button>
          }
         </td>
        </tr>
       )}
      </tbody>
     </table>

     {!commissionDraft.length&&
      <p className="muted">No commission assignments yet.</p>
     }
    </div>

    <div className="modal-actions">
     <button className="btn outline" onClick={closeCommission}>
      Close
     </button>
     <button className="btn primary" onClick={saveCommissionDraft}>
      <Save size={15}/> Save
     </button>
    </div>
   </Modal>
  }
 </>;
}
function Field({label,wide,children}){return <label className={'field-group '+(wide?'span-2':'')}>{label}{children}</label>}
function Modal({title,onClose,children,wide}){return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><section className={'modal '+(wide?'wide':'')}><div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={onClose}><X size={19}/></button></div>{children}</section></div>}
function EventDetails({order:o,roles,onClose,onEdit}){
 const assignments=o.assignments||[];
 const separateCommissions=Array.isArray(o.commissionAssignments);
 const commissions=o.commissionAssignments||[];

 const salary=assignments.reduce(
  (s,a)=>s+Number(a.salary||0),0
 );

 const legacyMemberCommission=separateCommissions?0:
  assignments.reduce((s,a)=>s+Number(
   a.commission??(
    Number(o.price||0)*Number(a.commissionRate||0)/100
   )
  ),0);

 const commissionTotal=separateCommissions?
  commissions.reduce((s,c)=>s+Number(
   c.commission??(
    Number(o.price||0)*Number(c.commissionRate||0)/100
   )
  ),0):legacyMemberCommission;

 const claims=assignments.flatMap(a=>
  (a.claims||[]).map(c=>({...c,memberName:a.name}))
 );

 const totalClaims=claims.reduce(
  (s,c)=>s+Number(c.amount||0),0
 );

 const totalAdditionalPay=assignments.reduce(
  (sum,a)=>sum+Number(a.additionalPay||0),0
 );

 const legacyCommission=o.commissionMode==='members'
  ?0:Number(o.commission||0);

 const eventIncome=Number(o.price||0)+Number(o.extra||0);
 const totalMemberPayable=
  salary+commissionTotal+totalAdditionalPay+totalClaims;
 const net=eventIncome-totalMemberPayable-legacyCommission;

 const unpaidAssignments=assignments.filter(a=>!a.paid);
 const paidAssignments=assignments.filter(a=>a.paid);
 const unpaidCommissions=commissions.filter(c=>!c.paid);
 const paidCommissions=commissions.filter(c=>c.paid);

 function commissionAmount(c){
  return Number(c.commission??(
   Number(o.price||0)*Number(c.commissionRate||0)/100
  ));
 }

 function assignmentTotal(a){
  const commission=separateCommissions?0:Number(
   a.commission??(
    Number(o.price||0)*Number(a.commissionRate||0)/100
   )
  );
  const claimTotal=(a.claims||[]).reduce(
   (s,c)=>s+Number(c.amount||0),0
  );
  return Number(a.salary||0)+commission+
   Number(a.additionalPay||0)+claimTotal;
 }

 function assignmentTable(list){
  return <div className="table-wrap">
   <table>
    <thead>
     <tr>
      <th>MEMBER</th>
      <th>ROLE</th>
      <th>SALARY</th>
      {!separateCommissions&&<th>COMMISSION</th>}
      <th>ADDITIONAL PAY</th>
      <th>CLAIMS</th>
      <th>TOTAL</th>
      <th>PAID DATE</th>
     </tr>
    </thead>
    <tbody>
     {list.map((a,i)=>{
      const claimTotal=(a.claims||[]).reduce(
       (s,c)=>s+Number(c.amount||0),0
      );
      return <tr key={a.id||a.performerId||i}>
       <td><b>{a.name||'Unnamed member'}</b></td>
       <td>{a.roleName||'-'}</td>
       <td>{money(a.salary)}</td>
       {!separateCommissions&&
        <td>{money(a.commission??(
         Number(o.price||0)*Number(a.commissionRate||0)/100
        ))}</td>
       }
       <td>
        <div>{money(a.additionalPay||0)}</div>
        <small>
         {a.additionalPayType==='Others'
          ?(a.additionalPayOther||'Others')
          :(a.additionalPayType||'-')}
        </small>
       </td>
       <td>{money(claimTotal)}</td>
       <td><b>{money(assignmentTotal(a))}</b></td>
       <td>{a.paidDate||'-'}</td>
      </tr>;
     })}
    </tbody>
   </table>
   {!list.length&&
    <p className="muted">No records in this section.</p>
   }
  </div>;
 }

 function commissionTable(list){
  return <div className="table-wrap">
   <table>
    <thead>
     <tr>
      <th>MEMBER</th>
      <th>COMMISSION RATE</th>
      <th>COMMISSION</th>
      <th>PAID DATE</th>
     </tr>
    </thead>
    <tbody>
     {list.map((c,i)=>
      <tr key={c.id||c.performerId||i}>
       <td><b>{c.name||'Unnamed member'}</b></td>
       <td>{Number(c.commissionRate||0)}%</td>
       <td>{money(commissionAmount(c))}</td>
       <td>{c.paidDate||'-'}</td>
      </tr>
     )}
    </tbody>
   </table>
   {!list.length&&
    <p className="muted">No commission records in this section.</p>
   }
  </div>;
 }

 return <>
  <Modal title="Event details" onClose={onClose} wide>
   <div className="detail-grid">
    <div><small>Event</small><b>{o.event||'Untitled event'}</b></div>
    <div><small>Event ID</small><b>{o.orderNo||'-'}</b></div>
    <div><small>Date</small><b>{o.date||'-'}</b></div>
    <div><small>Time</small><b>{o.time||'-'}</b></div>
    <div><small>Location</small><b>{o.location||'-'}</b></div>
    <div><small>Customer / organizer</small><b>{o.customer||'-'}</b></div>
    <div><small>Payment status</small><b>{o.paymentStatus||'Pending'}</b></div>
   </div>

   <div className="subsection">
    <h3>Event finances</h3>
    <div className="detail-grid">
     <div><small>Deposit</small><b>{money(o.depositAmount??o.price)}</b></div>
     <div><small>Balance</small><b>{money(o.balanceAmount||0)}</b></div>
     <div><small>Total Amount</small><b>{money(o.price)}</b></div>
     <div><small>Extra Income</small><b>{money(o.extra)}</b></div>
     <div><small>Total event income</small><b>{money(eventIncome)}</b></div>
     <div><small>Member salaries</small><b>{money(salary)}</b></div>
     <div><small>Member commissions</small><b>{money(commissionTotal)}</b></div>
     <div><small>Member additional pay</small><b>{money(totalAdditionalPay)}</b></div>
     <div><small>Member claims</small><b>{money(totalClaims)}</b></div>
     {legacyCommission>0&&
      <div><small>Previous event commission</small><b>{money(legacyCommission)}</b></div>
     }
     <div><small>Total member payment</small><b>{money(totalMemberPayable)}</b></div>
     <div><small>Net earnings</small><b>{money(net)}</b></div>
    </div>
   </div>

   <Panel title="Unpaid member payments" subtitle="Member salaries and additional claims that have not been paid.">
    {assignmentTable(unpaidAssignments)}
   </Panel>

   {separateCommissions&&
    <Panel title="Unpaid commissions" subtitle="Commission payments that have not been paid.">
     {commissionTable(unpaidCommissions)}
    </Panel>
   }

   <Panel title="Paid member payments" subtitle="Historical paid records for this event.">
    {assignmentTable(paidAssignments)}
   </Panel>

   {separateCommissions&&
    <Panel title="Paid commissions" subtitle="Historical paid commission records for this event.">
     {commissionTable(paidCommissions)}
    </Panel>
   }

   <Panel title="Additional member pay" subtitle="Individual claims recorded for this event.">
    <div className="table-wrap">
     <table>
      <thead>
       <tr>
        <th>MEMBER</th><th>CATEGORY</th><th>DESCRIPTION</th>
        <th>DATE</th><th>AMOUNT</th>
       </tr>
      </thead>
      <tbody>
       {claims.map((c,i)=>
        <tr key={c.id||i}>
         <td>{c.memberName}</td>
         <td>{c.category||'Other'}</td>
         <td>{c.description||'-'}</td>
         <td>{c.date||'-'}</td>
         <td>{money(c.amount)}</td>
        </tr>
       )}
      </tbody>
     </table>
     {!claims.length&&
      <p className="muted">No additional pay claims for this event.</p>
     }
    </div>
   </Panel>



   {o.notes&&
    <Panel title="Notes"><p>{o.notes}</p></Panel>
   }

   <div className="modal-actions">
    <button className="btn outline" onClick={onClose}>Close</button>
    <button className="btn primary" onClick={onEdit}>
     <Pencil size={15}/> Edit event
    </button>
   </div>
  </Modal>
 </>;
}
function Performers({performers,orders,addPerson,update,notify,roles=[]}){
 const [name,setName]=useState('');
 const [q,setQ]=useState('');
 const [roleFilter,setRoleFilter]=useState('all');
 const [selected,setSelected]=useState(null);
 const [editName,setEditName]=useState('');
 const [editRoles,setEditRoles]=useState([]);

 const list=performers.filter(p=>
  (p.name||'').toLowerCase().includes(q.toLowerCase())&&
  (roleFilter==='all'||(p.availableRoles||[]).includes(roleFilter))
 );

 function getHistory(p){
  return orders.flatMap(o=>{
   const assignment=(o.assignments||[]).find(
    a=>a.performerId===p.id
   );
   const separate=Array.isArray(o.commissionAssignments);
   const commissionAssignment=(o.commissionAssignments||[]).find(
    c=>c.performerId===p.id
   );

   if(!assignment&&!commissionAssignment)return [];

   let commission=0;

   if(separate){
    if(commissionAssignment){
     commission=Number(commissionAssignment.commission??(
      Number(o.price||0)*Number(commissionAssignment.commissionRate||0)/100
     ));
    }
   }else if(assignment){
    commission=Number(assignment.commission??(
     Number(o.price||0)*Number(assignment.commissionRate||0)/100
    ));
   }

   const salary=Number(assignment?.salary||0);
   const claims=assignment?.claims||[];
   const claimTotal=claims.reduce(
    (sum,c)=>sum+Number(c.amount||0),0
   );
   const additionalPay=Number(assignment?.additionalPay||0);

   const totalMemberPayment=
    salary+commission+additionalPay+claimTotal;
   const salaryAndClaimsPaid=!assignment||Boolean(assignment.paid);
   const commissionPaid=!commissionAssignment||Boolean(commissionAssignment.paid);

   return [{
    ...(assignment||commissionAssignment),
    event:o.event,
    date:o.date,
    orderNo:o.orderNo,
    orderId:o.id,
    roleName:assignment?.roleName||(commissionAssignment?'Commission':'-'),
    salary,
    commission,
    additionalPay,
    totalMemberPayment,
    paid:salaryAndClaimsPaid&&commissionPaid,
    paidDate:assignment?.paidDate||commissionAssignment?.paidDate||'',
    claims
   }];
  });
 }

 function getUnpaid(p){
  let total=0;

  orders.forEach(o=>{
   const separate=Array.isArray(o.commissionAssignments);

   (o.assignments||[])
    .filter(a=>a.performerId===p.id&&!a.paid)
    .forEach(a=>{
     total+=Number(a.salary||0);
     total+=Number(a.additionalPay||0);
     total+=(a.claims||[]).reduce(
      (s,c)=>s+Number(c.amount||0),0
     );

     if(!separate){
      total+=Number(a.commission??(
       Number(o.price||0)*Number(a.commissionRate||0)/100
      ));
     }
    });

   (o.commissionAssignments||[])
    .filter(c=>c.performerId===p.id&&!c.paid)
    .forEach(c=>{
     total+=Number(c.commission??(
      Number(o.price||0)*Number(c.commissionRate||0)/100
     ));
    });
  });

  return total;
 }

 function openMember(p){
  setSelected(p);
  setEditName(p.name||'');
  setEditRoles(Array.isArray(p.availableRoles)?p.availableRoles:[]);
 }

 function toggleRole(roleName){
  setEditRoles(current=>
   current.includes(roleName)
    ?current.filter(r=>r!==roleName)
    :[...current,roleName]
  );
 }

 function saveMember(){
  if(!editName.trim()){
   notify('Please enter the member name.');
   return;
  }

  update({
   performers:performers.map(p=>
    p.id===selected.id
     ?{
       ...p,
       name:editName.trim(),
       availableRoles:editRoles
      }
     :p
   )
  });

  setSelected(null);
  notify('Member details updated.');
 }

 function remove(p){
  if(!confirm(
   `Remove ${p.name} from the member directory? Historical event records will remain.`
  ))return;

  update({
   performers:performers.filter(x=>x.id!==p.id)
  });

  if(selected?.id===p.id)setSelected(null);
  notify('Member removed.');
 }

 function add(){
  if(!name.trim()){
   notify('Please enter a member name.');
   return;
  }

  addPerson(name.trim());
  setName('');
  notify('Member added.');
 }

 const history=selected?getHistory(selected):[];
 const rolePalette=[
  {background:'#fce8e6',color:'#a33f36'},
  {background:'#e7f0ff',color:'#365f9d'},
  {background:'#e7f4e9',color:'#36764a'},
  {background:'#fff1d9',color:'#98651d'},
  {background:'#f1e9fb',color:'#7046a0'},
  {background:'#e3f3f2',color:'#28736e'},
  {background:'#fbe9f2',color:'#9b4773'},
  {background:'#eceff1',color:'#52616b'}
 ];
 function roleStyle(role){
  const index=roles.findIndex(r=>(typeof r==='string'?r:r.name)===role);
  return rolePalette[(index<0?0:index)%rolePalette.length];
 }

 return <>
  <Heading
   eyebrow="TEAM DIRECTORY"
   title="Members"
   desc="Manage your club members and view their event participation."
  />

  <div className="panel">
   <div className="panel-head">
    <div>
     <h3>Add member</h3>
     <p>Add a member to your club directory.</p>
    </div>
   </div>

   <div className="assignment-add">
    <input
     value={name}
     onChange={e=>setName(e.target.value)}
     placeholder="Enter member name"
     onKeyDown={e=>e.key==='Enter'&&add()}
    />
    <button className="btn primary" onClick={add}>
     <UserPlus size={15}/> Add member
    </button>
   </div>
  </div>

  <div className="panel">
   <div className="panel-head">
    <div>
     <h3>Member directory</h3>
     <p>{performers.length} registered member(s)</p>
    </div>
    <div className="member-directory-filters">
     <label>
      <span>Filter by role</span>
      <select
       className="field"
       value={roleFilter}
       onChange={e=>setRoleFilter(e.target.value)}
      >
       <option value="all">All roles</option>
       {roles.map(r=>{
        const roleName=typeof r==='string'?r:r.name;
        return roleName?<option key={roleName} value={roleName}>{roleName}</option>:null;
       })}
      </select>
     </label>
     <div className="search-box">
      <Search size={15}/>
      <input
       value={q}
       onChange={e=>setQ(e.target.value)}
       placeholder="Search by member name..."
      />
     </div>
    </div>
   </div>

   <div className="member-list">
    {list.map(p=>{
     const unpaid=getUnpaid(p);
     const memberHistory=getHistory(p);
     const initials=(p.name||'?')
      .trim()
      .split(/\\s+/)
      .slice(0,2)
      .map(part=>part[0]||'')
      .join('')
      .toUpperCase();

     return <div
      className="member-card"
      key={p.id}
      onClick={()=>openMember(p)}
      onKeyDown={e=>{
       if(e.key==='Enter'||e.key===' '){
        e.preventDefault();
        openMember(p);
       }
      }}
      role="button"
      tabIndex={0}
     >
      <div className="member-card-head">
       <div className="member-identity">
        <div className="person-avatar">{initials}</div>
        <div className="member-identity-text">
         <h3>{p.name}</h3>
         <small>{memberHistory.length} event participation(s)</small>
        </div>
       </div>

       <button
        className="icon-button danger"
        title="Remove member"
        onClick={e=>{
         e.stopPropagation();
         remove(p);
        }}
       >
        <Trash2 size={16}/>
       </button>
      </div>

      <div className="member-roles">
       {(p.availableRoles||[]).length
        ?p.availableRoles.map(role=>
         <span className="member-role-tag" key={role} style={roleStyle(role)}>{role}</span>
        )
        :<span className="muted">No available roles set</span>
       }
      </div>

      <div className="member-card-footer">
       <div>
        <small>Outstanding payment</small>
        <b className={unpaid>0?'member-unpaid':'member-settled'}>
         {money(unpaid)}
        </b>
       </div>
       <span className="member-view-link">View details <ChevronRight size={14}/></span>
      </div>
     </div>;
    })}

    {!list.length&&
     <Empty
      title={q?'No matching members':'No members yet'}
      desc={q?'Try another search term.':'Add your first member above.'}
     />
    }
   </div>
  </div>

  {selected&&
   <Modal
    title="Member details"
    onClose={()=>setSelected(null)}
    wide
   >
    <div className="form-grid">
     <Field label="Member name">
      <input
       value={editName}
       onChange={e=>setEditName(e.target.value)}
      />
     </Field>
    </div>

    <div className="subsection">
     <h3>Available roles</h3>
     <p className="muted">Select the roles this member is available to perform.</p>
     <div style={{
      display:'grid',
      gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',
      gap:10
     }}>
      {roles.map(r=>{
       const roleName=typeof r==='string'?r:r.name;
       if(!roleName)return null;

       return <label
        key={roleName}
        style={{display:'flex',alignItems:'center',gap:8}}
       >
        <input
         type="checkbox"
         checked={editRoles.includes(roleName)}
         onChange={()=>toggleRole(roleName)}
        />
        {roleName}
       </label>;
      })}
     </div>
     {!roles.length&&
      <p className="muted">Add roles in Settings first.</p>
     }
    </div>

    <div className="modal-actions">
     <button className="btn primary" onClick={saveMember}>
      <Save size={15}/> Save member details
     </button>
    </div>

    <Panel
     title="Participation history"
     subtitle="Events this member has participated in."
    >
     <div className="table-wrap">
      <table>
       <thead>
        <tr>
         <th>EVENT</th>
         <th>DATE</th>
         <th>ROLE</th>
         <th>SALARY</th>
         <th>COMMISSION</th>
         <th>ADDITIONAL PAY</th>
         <th>CLAIMS</th>
         <th>TOTAL MEMBER PAYMENT</th>
         <th>PAYMENT STATUS</th>
         <th>PAID DATE</th>
        </tr>
       </thead>
       <tbody>
        {history.map((a,i)=>{
         const claimTotal=(a.claims||[]).reduce(
          (s,c)=>s+Number(c.amount||0),0
         );

         return <tr key={a.id||a.orderId+'-'+i}>
          <td>{a.event||a.orderNo||'-'}</td>
          <td>{a.date||'-'}</td>
          <td>{a.roleName||'-'}</td>
          <td>{money(a.salary)}</td>
          <td>{money(a.commission)}</td>
          <td>
           <div>{money(a.additionalPay||0)}</div>
           <small>
            {a.additionalPayType==='Others'
             ?(a.additionalPayOther||'Others')
             :(a.additionalPayType||'-')}
           </small>
          </td>
          <td>{money(claimTotal)}</td>
          <td><strong>{money(a.totalMemberPayment)}</strong></td>
          <td>
           <span className={'status '+(a.paid?'good':'pending')}>
            {a.paid?'Paid':'Unpaid'}
           </span>
          </td>
          <td>{a.paidDate||'-'}</td>
         </tr>;
        })}
       </tbody>
      </table>
      {!history.length&&
       <p className="muted">No event participation history yet.</p>
      }
     </div>
    </Panel>
   </Modal>
  }
 </>;
}
function Salary({orders,data,update,notify}){
 const [editing,setEditing]=useState(null);
 const [expanded,setExpanded]=useState(null);
 const [form,setForm]=useState({
  salary:'',
  additionalPay:'0',
  additionalPayType:'',
  additionalPayOther:'',
  claims:[]
 });
 const [claimDraft,setClaimDraft]=useState({
  category:'Medical',
  description:'',
  date:today(),
  amount:''
 });

 const [expenseDraft,setExpenseDraft]=useState({
  type:'Other',
  description:'',
  date:today(),
  amount:''
 });

 function updateOrder(orderId,callback){
  update({
   orders:orders.map(o=>
    o.id===orderId?callback(o):o
   )
  });
 }

 function assignmentTotal(o,a){
  const separate=Array.isArray(o.commissionAssignments);
  const commission=separate?0:Number(
   a.commission??(
    Number(o.price||0)*Number(a.commissionRate||0)/100
   )
  );
  const claims=(a.claims||[]).reduce(
   (s,c)=>s+Number(c.amount||0),0
  );
  return Number(a.salary||0)+commission+
   Number(a.additionalPay||0)+claims;
 }

 function commissionAmount(o,c){
  return Number(c.commission??(
   Number(o.price||0)*Number(c.commissionRate||0)/100
  ));
 }

 function getUnpaid(o){
  const assignments=(o.assignments||[])
   .filter(a=>!a.paid);

  const commissions=(o.commissionAssignments||[])
   .filter(c=>!c.paid);

  return {
   assignments,
   commissions,
   total:
    assignments.reduce((s,a)=>s+assignmentTotal(o,a),0)+
    commissions.reduce((s,c)=>s+commissionAmount(o,c),0)
  };
 }

 const unpaidOrders=orders.map(o=>({
  ...o,
  unpaid:getUnpaid(o)
 })).filter(o=>
  o.unpaid.assignments.length||
  o.unpaid.commissions.length
 );

 const outstanding=unpaidOrders.reduce(
  (s,o)=>s+o.unpaid.total,0
 );

 function markAssignmentPaid(o,a){
  if(!confirm(
   `Mark ${a.name||'this member'}'s payment for "${o.event}" as paid?`
  ))return;

  updateOrder(o.id,current=>({
   ...current,
   assignments:(current.assignments||[]).map(x=>
    x.id===a.id
     ?{...x,paid:true,paidDate:today()}
     :x
   )
  }));

  notify('Member payment marked as paid.');
 }

 function markCommissionPaid(o,c){
  if(!confirm(
   `Mark ${c.name||'this member'}'s commission for "${o.event}" as paid?`
  ))return;

  updateOrder(o.id,current=>({
   ...current,
   commissionAssignments:(current.commissionAssignments||[]).map(x=>
    x.id===c.id
     ?{...x,paid:true,paidDate:today()}
     :x
   )
  }));

  notify('Commission marked as paid.');
 }

 function openEdit(o,a){
  const index=(o.assignments||[]).findIndex(x=>x.id===a.id);

  setEditing({
   orderId:o.id,
   index,
   event:o.event,
   orderPrice:Number(o.price||0),
   name:a.name||''
  });

  setForm({
   salary:String(a.salary??0),
   additionalPay:String(a.additionalPay??0),
   additionalPayType:a.additionalPayType||'',
   additionalPayOther:a.additionalPayOther||'',
   claims:(a.claims||[]).map(c=>({...c}))
  });
 }

 function addClaim(){
  const amount=Number(claimDraft.amount);

  if(!claimDraft.description.trim()){
   notify('Please enter a claim description.');
   return;
  }

  if(!claimDraft.date){
   notify('Please select a claim date.');
   return;
  }

  if(!Number.isFinite(amount)||amount<=0){
   notify('Please enter a valid claim amount.');
   return;
  }

  setForm(x=>({
   ...x,
   claims:[
    ...x.claims,
    {
     id:uid(),
     category:claimDraft.category,
     description:claimDraft.description.trim(),
     date:claimDraft.date,
     amount
    }
   ]
  }));

  setClaimDraft({
   category:'Medical',
   description:'',
   date:today(),
   amount:''
  });
 }

 function removeClaim(id){
  setForm(x=>({
   ...x,
   claims:x.claims.filter(c=>c.id!==id)
  }));
 }

 function saveEdit(){
  if(!editing)return;

  const salary=Number(form.salary);
  const additionalPay=Number(form.additionalPay||0);

  if(!Number.isFinite(salary)||salary<0){
   notify('Please enter a valid salary.');
   return;
  }

  if(!Number.isFinite(additionalPay)||additionalPay<0){
   notify('Please enter a valid additional pay amount.');
   return;
  }

  if(additionalPay>0&&!form.additionalPayType){
   notify('Please select what the additional pay is for.');
   return;
  }

  if(additionalPay>0&&form.additionalPayType==='Others'&&
   !form.additionalPayOther.trim()){
   notify('Please enter the custom payment purpose.');
   return;
  }

  const claims=form.claims.map(c=>({
   ...c,
   amount:Number(c.amount||0)
  }));

  updateOrder(editing.orderId,o=>({
   ...o,
   assignments:(o.assignments||[]).map((a,i)=>
    i===editing.index
     ?{
       ...a,
       salary,
       additionalPay,
       additionalPayType:form.additionalPayType,
       additionalPayOther:form.additionalPayOther,
       claims
      }
     :a
   )
  }));

  setEditing(null);
  notify('Member payment updated.');
 }

 function addExpense(){
  const amount=Number(expenseDraft.amount);

  if(!expenseDraft.description.trim()){
   notify('Please enter an expense description.');
   return;
  }

  if(!expenseDraft.date){
   notify('Please select an expense date.');
   return;
  }

  if(!Number.isFinite(amount)||amount<=0){
   notify('Please enter a valid expense amount.');
   return;
  }

  update({
   expenses:[
    ...(data.expenses||[]),
    {
     id:uid(),
     type:expenseDraft.type,
     description:expenseDraft.description.trim(),
     date:expenseDraft.date,
     amount
    }
   ]
  });

  setExpenseDraft(x=>({
   ...x,
   description:'',
   amount:'',
   date:today()
  }));

  notify('Club expense added.');
 }

 function removeExpense(expenseId){
  if(!confirm('Remove this expense?'))return;

  update({
   expenses:(data.expenses||[]).filter(e=>e.id!==expenseId)
  });

  notify('Expense removed.');
 }

 const allExpenses=data.expenses||[];

 return <>
  <Heading
   eyebrow="PAYMENT MANAGEMENT"
   title="Payment"
   desc="Manage outstanding member salaries, commissions and additional expenses."
  />

  <div className="stats-grid">
   <Stat
    label="Unpaid salary"
    value={unpaidOrders.length}
    sub="Events with outstanding member payments"
    icon={Wallet}
   />
   <Stat
    label="Unpaid records"
    value={unpaidOrders.reduce(
     (s,o)=>s+o.unpaid.assignments.length+o.unpaid.commissions.length,0
    )}
    sub="Member and commission payments"
    icon={Users}
   />
   <Stat
    label="Total outstanding"
    value={money(outstanding)}
    sub="Amount yet to be paid"
    icon={Calculator}
   />
  </div>

  <Panel
   title="Unpaid salary"
   subtitle="Only events with outstanding member payments or commissions are shown here."
  >
   {!unpaidOrders.length?
    <Empty
     title="No unpaid payments"
     desc="All member payments and commissions have been paid."
    />
    :
    <div className="member-list">
     {unpaidOrders.map(o=>{
      const isOpen=expanded===o.id;

      return <div className="member-card" key={o.id}>
       <div
        className="member-card-head"
        style={{cursor:'pointer'}}
        onClick={()=>setExpanded(isOpen?null:o.id)}
       >
        <div>
         <h3>{o.event||'Untitled event'}</h3>
         <small>
          {o.orderNo||'No event number'} · {o.date||'No date'}{o.time?` · ${o.time}`:''}
         </small>
        </div>
        <div style={{
         display:'flex',
         alignItems:'center',
         gap:12
        }}>
         <div style={{textAlign:'right'}}>
          <b style={{color:'#dc2626'}}>{money(o.unpaid.total)}</b>
          <small style={{display:'block'}}>Outstanding</small>
         </div>
         <button className="icon-button" type="button">
          {isOpen?<X size={16}/>:<Search size={16}/>}
         </button>
        </div>
       </div>

       {isOpen&&
        <div className="subsection">
         <div className="table-wrap">
          <table>
           <thead>
            <tr>
             <th>MEMBER</th>
             <th>ROLE</th>
             <th>SALARY</th>
             <th>COMMISSION</th>
             <th>CLAIMS</th>
             <th>UNPAID AMOUNT</th>
             <th>ACTIONS</th>
            </tr>
           </thead>
           <tbody>
            {o.unpaid.assignments.map((a,i)=>{
             const claims=(a.claims||[]).reduce(
              (s,c)=>s+Number(c.amount||0),0
             );
             const separate=Array.isArray(o.commissionAssignments);
             const commission=separate?0:Number(
              a.commission??(
               Number(o.price||0)*Number(a.commissionRate||0)/100
              )
             );

             return <tr key={a.id||i}>
              <td><b>{a.name||'-'}</b></td>
              <td>{a.roleName||'-'}</td>
              <td>{money(a.salary)}</td>
              <td>{separate?'-':money(commission)}</td>
              <td>{money(claims)}</td>
              <td><b>{money(assignmentTotal(o,a))}</b></td>
              <td>
               <div className="table-actions">
                <button
                 className="icon-button"
                 title="Edit payment"
                 onClick={()=>openEdit(o,a)}
                >
                 <Pencil size={15}/>
                </button>
                <button
                 className="btn small primary"
                 onClick={()=>markAssignmentPaid(o,a)}
                >
                 <Check size={14}/> Mark paid
                </button>
               </div>
              </td>
             </tr>;
            })}

            {o.unpaid.commissions.map((c,i)=>
             <tr key={c.id||'commission-'+i}>
              <td><b>{c.name||'Unnamed member'}</b></td>
              <td>Commission</td>
              <td>-</td>
              <td>{Number(c.commissionRate||0)}%</td>
              <td>-</td>
              <td><b>{money(commissionAmount(o,c))}</b></td>
              <td>
               <button
                className="btn small primary"
                onClick={()=>markCommissionPaid(o,c)}
               >
                <Check size={14}/> Mark paid
               </button>
              </td>
             </tr>
            )}
           </tbody>
          </table>
         </div>
        </div>
       }
      </div>;
     })}
    </div>
   }
  </Panel>

  <Panel
   title="Additional expenses"
   subtitle="Record club expenses independently of individual events."
  >
   <div className="form-grid">
    <Field label="Expense category">
     <select
      value={expenseDraft.type}
      onChange={e=>setExpenseDraft(x=>({...x,type:e.target.value}))}
     >
      <option>Medical</option>
      <option>Transportation</option>
      <option>Food</option>
      <option>Beverage</option>
      <option>Toll</option>
      <option>Parking</option>
      <option>Equipment</option>
      <option>Other</option>
     </select>
    </Field>

    <Field label="Description">
     <input
      value={expenseDraft.description}
      onChange={e=>setExpenseDraft(x=>({...x,description:e.target.value}))}
      placeholder="e.g. First aid supplies"
     />
    </Field>

    <Field label="Date">
     <input
      type="date"
      value={expenseDraft.date}
      onChange={e=>setExpenseDraft(x=>({...x,date:e.target.value}))}
     />
    </Field>

    <Field label="Amount (RM)">
     <input
      type="number"
      min="0"
      step="0.01"
      value={expenseDraft.amount}
      onChange={e=>setExpenseDraft(x=>({...x,amount:e.target.value}))}
     />
    </Field>
   </div>

   <button className="btn primary" onClick={addExpense}>
    <Plus size={15}/> Add expense
   </button>

   <div className="subsection">
    <h3>Recorded expenses</h3>
    <div className="table-wrap">
     <table>
      <thead>
       <tr>
        <th>CATEGORY</th>
        <th>DESCRIPTION</th>
        <th>DATE</th>
        <th>AMOUNT</th>
        <th>ACTION</th>
       </tr>
      </thead>
      <tbody>
       {allExpenses.map((e,i)=>
        <tr key={e.id||i}>
         <td>{e.type||'-'}</td>
         <td>{e.description||'-'}</td>
         <td>{e.date||'-'}</td>
         <td>{money(e.amount)}</td>
         <td>
          <button
           className="icon-button danger"
           title="Remove expense"
           onClick={()=>removeExpense(e.id)}
          >
           <Trash2 size={15}/>
          </button>
         </td>
        </tr>
       )}
      </tbody>
     </table>
     {!allExpenses.length&&
      <p className="muted">No additional expenses recorded yet.</p>
     }
    </div>
   </div>
  </Panel>

  {editing&&
   <Modal
    title="Edit unpaid member payment"
    onClose={()=>setEditing(null)}
    wide
   >
    <div className="account-note">
     <Wallet size={17}/>
     <span>
      Editing the unpaid payment for {editing.name} — {editing.event}.
     </span>
    </div>

    <Field label="Salary (RM)">
     <input
      type="number"
      min="0"
      step="0.01"
      value={form.salary}
      onChange={e=>setForm(x=>({...x,salary:e.target.value}))}
     />
    </Field>

    <div className="form-grid">
     <Field label="Additional pay (RM)">
      <input
       type="number"
       min="0"
       step="0.01"
       value={form.additionalPay}
       onChange={e=>setForm(x=>({...x,additionalPay:e.target.value}))}
       placeholder="0.00"
      />
     </Field>

     <Field label="Pay for">
      <select
       value={form.additionalPayType}
       onChange={e=>setForm(x=>({...x,additionalPayType:e.target.value}))}
      >
       <option value="">Select purpose</option>
       <option value="Laundry">Laundry</option>
       <option value="Food">Food</option>
       <option value="Toll">Toll</option>
       <option value="Parking">Parking</option>
       <option value="Others">Others</option>
      </select>
     </Field>

     {form.additionalPayType==='Others'&&
      <Field label="Custom purpose">
       <input
        value={form.additionalPayOther}
        onChange={e=>setForm(x=>({...x,additionalPayOther:e.target.value}))}
        placeholder="Enter payment purpose"
       />
      </Field>
     }
    </div>

    <div className="subsection">
     <div className="subsection-head">
      <div>
       <h3>Additional pay claims</h3>
       <p>Record medical, food, toll, parking and other claims for this member.</p>
      </div>
     </div>

     {(form.claims||[]).map(c=>
      <div className="history-row" key={c.id}>
       <span>
        <b>{c.category||'Other'}</b> · {c.description}
        <small>{c.date||'-'}</small>
       </span>
       <b>{money(c.amount)}</b>
       <button
        className="icon-button danger"
        title="Remove claim"
        onClick={()=>removeClaim(c.id)}
       >
        <Trash2 size={14}/>
       </button>
      </div>
     )}

     {!form.claims.length&&
      <p className="muted">No additional claims recorded.</p>
     }

     <div className="form-grid">
      <Field label="Category">
       <select
        value={claimDraft.category}
        onChange={e=>setClaimDraft(x=>({...x,category:e.target.value}))}
       >
        <option>Medical</option>
        <option>Food</option>
        <option>Toll</option>
        <option>Parking</option>
        <option>Transportation</option>
        <option>Equipment</option>
        <option>Other</option>
       </select>
      </Field>

      <Field label="Claim date">
       <input
        type="date"
        value={claimDraft.date}
        onChange={e=>setClaimDraft(x=>({...x,date:e.target.value}))}
       />
      </Field>

      <Field label="Description">
       <input
        value={claimDraft.description}
        onChange={e=>setClaimDraft(x=>({...x,description:e.target.value}))}
        placeholder="e.g. Medical expenses after performance"
       />
      </Field>

      <Field label="Amount (RM)">
       <input
        type="number"
        min="0"
        step="0.01"
        value={claimDraft.amount}
        onChange={e=>setClaimDraft(x=>({...x,amount:e.target.value}))}
       />
      </Field>
     </div>

     <button className="btn outline" onClick={addClaim}>
      <Plus size={15}/> Add claim
     </button>
    </div>

    <div className="sub-total">
     <span>Salary</span>
     <b>{money(form.salary)}</b>
    </div>
    <div className="sub-total">
     <span>Additional pay — {form.additionalPayType==='Others'
      ?(form.additionalPayOther||'Others')
      :(form.additionalPayType||'Not selected')}</span>
     <b>{money(form.additionalPay)}</b>
    </div>
    <div className="sub-total">
     <span>Additional claims</span>
     <b>{money(form.claims.reduce((s,c)=>s+Number(c.amount||0),0))}</b>
    </div>
    <div className="sub-total">
     <span>Total member payment</span>
     <b>
      {money(
       Number(form.salary||0)+
       Number(form.additionalPay||0)+
       form.claims.reduce((s,c)=>s+Number(c.amount||0),0)
      )}
     </b>
    </div>

    <div className="modal-actions">
     <button className="btn outline" onClick={()=>setEditing(null)}>
      Cancel
     </button>
     <button className="btn primary" onClick={saveEdit}>
      <Save size={15}/> Save changes
     </button>
    </div>
   </Modal>
  }
 </>;
}
function Finance({orders,update,notify}){
 const [selected,setSelected]=useState(orders[0]?.id||'');
 const [type,setType]=useState('Transportation');
 const [desc,setDesc]=useState('');
 const [amount,setAmount]=useState('');

 const order=orders.find(o=>o.id===selected);
 const assignments=order?.assignments||[];

 function addExpense(){
  if(!order||Number(amount)<=0)return;

  update({
   orders:orders.map(o=>o.id===selected
    ?{
      ...o,
      expenses:[
       ...(o.expenses||[]),
       {
        id:uid(),
        type,
        description:desc,
        amount:Number(amount),
        date:today()
       }
      ]
     }
    :o
   )
  });

  setDesc('');
  setAmount('');
  notify('Expense recorded');
 }

 const income=Number(order?.price||0)+Number(order?.extra||0);

 const memberSalary=assignments.reduce(
  (sum,a)=>sum+Number(a.salary||0),0
 );

 const memberCommission=Array.isArray(order?.commissionAssignments)
  ?order.commissionAssignments.reduce((sum,a)=>sum+Number(
    a.commission??(
     Number(order?.price||0)*Number(a.commissionRate||0)/100
    )
   ),0)
  :assignments.reduce((sum,a)=>sum+Number(
    a.commission??(
     Number(order?.price||0)*Number(a.commissionRate||0)/100
    )
   ),0);

 const memberClaims=assignments.reduce(
  (sum,a)=>sum+(a.claims||[]).reduce(
   (s,c)=>s+Number(c.amount||0),0
  ),0
 );

 const memberAdditionalPay=assignments.reduce(
  (sum,a)=>sum+Number(a.additionalPay||0),0
 );

 const legacyCommission=
  order?.commissionMode==='members'
   ?0
   :Number(order?.commission||0);

 const totalCommission=memberCommission+legacyCommission;

 const expenses=(order?.expenses||[]).reduce(
  (sum,e)=>sum+Number(e.amount||0),0
 );

 const totalMemberPay=
  memberSalary+memberCommission+memberAdditionalPay+memberClaims;

 const net=income-totalMemberPay-legacyCommission-expenses;

 return <>
  <Heading
   eyebrow="CLUB FINANCES"
   title="Finance calculator"
   desc="Review member payments, commissions, claims and event expenses."
  />

  <div className="finance-select">
   <label>
    Select event
    <select
     value={selected}
     onChange={e=>setSelected(e.target.value)}
    >
     <option value="">Choose an event</option>
     {orders.map(o=>
      <option key={o.id} value={o.id}>
       {o.orderNo} · {o.event}
      </option>
     )}
    </select>
   </label>
  </div>

  {order?<>
   <div className="finance-grid">
    <div className="finance-card">
     <span>Event income</span>
     <b>{money(income)}</b>
    </div>

    <div className="finance-card">
     <span>Member salaries</span>
     <b>{money(memberSalary)}</b>
    </div>

    <div className="finance-card">
     <span>Member commissions</span>
     <b>{money(memberCommission)}</b>
    </div>

    <div className="finance-card">
     <span>Member additional pay</span>
     <b>{money(memberAdditionalPay)}</b>
    </div>

    <div className="finance-card">
     <span>Additional member claims</span>
     <b>{money(memberClaims)}</b>
    </div>

    <div className="finance-card">
     <span>Event expenses</span>
     <b>{money(expenses)}</b>
    </div>

    <div className="finance-card net-card">
     <span>Net earnings</span>
     <b>{money(net)}</b>
     <small>
      Income − member payments − legacy commission − event expenses
     </small>
    </div>
   </div>

   <Panel
    title="Member payment breakdown"
    desc="Each member's salary, commission and additional claims."
   >
    <div className="table-wrap">
     <table>
      <thead>
       <tr>
        <th>MEMBER</th>
        <th>ROLE</th>
        <th>SALARY</th>
        <th>COMMISSION</th>
        <th>CLAIMS</th>
        <th>TOTAL PAYABLE</th>
        <th>PAYMENT</th>
       </tr>
      </thead>

      <tbody>
       {assignments.map((a,i)=>{
        const commission=Number(
         a.commission??(
          Number(order.price||0)*Number(a.commissionRate||0)/100
         )
        );

        const claimTotal=(a.claims||[]).reduce(
         (sum,c)=>sum+Number(c.amount||0),0
        );

        const total=
         Number(a.salary||0)+commission+claimTotal;

        return <tr key={a.id||a.performerId||i}>
         <td><b>{a.name||'Unnamed member'}</b></td>
         <td>{a.roleName||'-'}</td>
         <td>{money(a.salary)}</td>
         <td>{money(commission)}</td>
         <td>{money(claimTotal)}</td>
         <td><b>{money(total)}</b></td>
         <td>
          <span className={'status '+(a.paid?'good':'pending')}>
           {a.paid?'Paid':'Unpaid'}
          </span>
         </td>
        </tr>;
       })}
      </tbody>
     </table>

     {!assignments.length&&
      <p className="muted">No members have been assigned to this event.</p>
     }
    </div>

    <div className="detail-grid">
     <div>
      <small>Total member payments</small>
      <b>{money(totalMemberPay)}</b>
     </div>
     <div>
      <small>Total member commission</small>
      <b>{money(memberCommission)}</b>
     </div>
    </div>
   </Panel>

   <Panel
    title="Additional member claims"
    desc="Individual claims such as toll, food, parking and other costs."
   >
    <div className="table-wrap">
     <table>
      <thead>
       <tr>
        <th>MEMBER</th>
        <th>CATEGORY</th>
        <th>DESCRIPTION</th>
        <th>DATE</th>
        <th>AMOUNT</th>
       </tr>
      </thead>

      <tbody>
       {assignments.flatMap((a,i)=>
        (a.claims||[]).map((c,j)=>
         <tr key={c.id||`${a.id||a.performerId||i}-${j}`}>
          <td>{a.name||'Unnamed member'}</td>
          <td>{c.category||'-'}</td>
          <td>{c.description||'-'}</td>
          <td>{c.date||'-'}</td>
          <td>{money(c.amount)}</td>
         </tr>
        )
       )}
      </tbody>
     </table>

     {!assignments.some(a=>(a.claims||[]).length>0)&&
      <p className="muted">No additional member claims recorded.</p>
     }
    </div>
   </Panel>

   {order.commissionMode!=='members'&&
    <Panel
     title="Legacy commission"
     desc="This is the original event-level commission for older records."
    >
     <div className="finance-card">
      <span>Event-level commission</span>
      <b>{money(legacyCommission)}</b>
     </div>
     <Commission
      order={order}
      orders={orders}
      update={update}
      notify={notify}
     />
    </Panel>
   }

   <Panel
    title="Record event expenses"
    desc="Record club expenses that are separate from individual member claims."
   >
    <div className="expense-form">
     <select value={type} onChange={e=>setType(e.target.value)}>
      <option>Transportation</option>
      <option>Food</option>
      <option>Beverage</option>
      <option>Parking / toll</option>
      <option>Equipment</option>
      <option>Other</option>
     </select>

     <input
      value={desc}
      onChange={e=>setDesc(e.target.value)}
      placeholder="Description"
     />

     <input
      type="number"
      min="0"
      value={amount}
      onChange={e=>setAmount(e.target.value)}
      placeholder="Amount RM"
     />

     <button className="btn primary" onClick={addExpense}>
      <Plus size={15}/> Add expense
     </button>
    </div>

    <div className="table-wrap">
     <table>
      <thead>
       <tr>
        <th>TYPE</th>
        <th>DESCRIPTION</th>
        <th>DATE</th>
        <th>AMOUNT</th>
        <th/>
       </tr>
      </thead>

      <tbody>
       {(order.expenses||[]).map(x=>
        <tr key={x.id}>
         <td>{x.type}</td>
         <td>{x.description}</td>
         <td>{x.date}</td>
         <td>{money(x.amount)}</td>
         <td>
          <button
           className="icon-button danger"
           onClick={()=>
            update({
             orders:orders.map(o=>o.id===selected
              ?{
                ...o,
                expenses:(o.expenses||[]).filter(e=>e.id!==x.id)
               }
              :o
             )
            })
           }
          >
           <Trash2 size={15}/>
          </button>
         </td>
        </tr>
       )}
      </tbody>
     </table>

     {!order.expenses?.length&&
      <p className="muted">No event expenses recorded yet.</p>
     }
    </div>
   </Panel>
  </>:<Empty
   title="Select an event"
   desc="Choose an event to review member payments and event expenses."
  />}
 </>;
}
function Commission({order,orders,update,notify}){
 const [rate,setRate]=useState(String(order.commissionRate??''));

 useEffect(()=>{
  setRate(String(order.commissionRate??''));
 },[order.id,order.commissionRate]);

 const base=Number(order.price||0);
 const result=base*Number(rate||0)/100;

 return <div className="commission-row">
  <div>
   <label>Commission rate (%)
    <input
     type="number"
     min="0"
     max="100"
     step="0.01"
     value={rate}
     onChange={e=>setRate(e.target.value)}
     placeholder="e.g. 10"
    />
   </label>
   <div className="muted">
    Based on event total amount: {money(base)}
   </div>
  </div>
  <div className="commission-result">
   <small>Calculated commission</small>
   <b>{money(result)}</b>
  </div>
  <button className="btn primary" onClick={()=>{
   if(rate===''||Number(rate)<0||Number(rate)>100){
    alert('Please enter a commission percentage between 0 and 100.');
    return;
   }
   update({
    orders:orders.map(o=>o.id===order.id?{
     ...o,
     commissionRate:Number(rate),
     commission:Number(result.toFixed(2))
    }:o)
   });
   notify('Commission saved to event');
  }}>
   Save commission
  </button>
 </div>;
}
function Utilities({data,update,notify}){
 const [name,setName]=useState('');
 const [qty,setQty]=useState('1');
 const [condition,setCondition]=useState('Good');
 const [purchase,setPurchase]=useState({
  name:'',
  qty:'1',
  cost:'',
  date:today()
 });
 const [editingPurchaseId,setEditingPurchaseId]=useState(null);

 const items=data.utilities||[];
 const purchases=data.purchases||[];

 function add(){
  if(!name.trim()){
   notify('Please enter an item name.');
   return;
  }

  const quantity=Number(qty);

  if(!Number.isFinite(quantity)||quantity<1){
   notify('Please enter a valid quantity.');
   return;
  }

  update({
   utilities:[
    ...items,
    {
     id:uid(),
     name:name.trim(),
     quantity,
     condition
    }
   ]
  });

  setName('');
  setQty('1');
  setCondition('Good');
  notify('Utility added.');
 }

 function resetPurchaseForm(){
  setPurchase({
   name:'',
   qty:'1',
   cost:'',
   date:today()
  });
  setEditingPurchaseId(null);
 }

 function buy(){
  if(!purchase.name.trim()){
   notify('Please enter an item name.');
   return;
  }

  const quantity=Number(purchase.qty);
  const amount=Number(purchase.cost);

  if(!Number.isFinite(quantity)||quantity<1){
   notify('Please enter a valid quantity.');
   return;
  }

  if(!Number.isFinite(amount)||amount<=0){
   notify('Please enter a valid purchase cost.');
   return;
  }

  if(editingPurchaseId){
   update({
    purchases:purchases.map(p=>
     p.id===editingPurchaseId
      ?{
        ...p,
        name:purchase.name.trim(),
        qty:quantity,
        cost:amount,
        date:purchase.date
       }
      :p
    )
   });

   resetPurchaseForm();
   notify('Purchase record updated.');
   return;
  }

  const newPurchase={
   id:uid(),
   name:purchase.name.trim(),
   qty:quantity,
   cost:amount,
   date:purchase.date
  };

  update({
   purchases:[newPurchase,...purchases],
   utilities:[
    ...items,
    {
     id:uid(),
     name:newPurchase.name,
     quantity:quantity,
     condition:'New'
    }
   ]
  });

  resetPurchaseForm();
  notify('Purchase recorded and added to inventory.');
 }

 function editPurchase(p){
  setEditingPurchaseId(p.id);
  setPurchase({
   name:p.name||'',
   qty:String(p.qty||1),
   cost:String(p.cost||''),
   date:p.date||today()
  });

  window.scrollTo({top:0,behavior:'smooth'});
 }

 function removePurchase(p){
  if(!confirm(`Delete the purchase record for ${p.name||'this item'}? This will not remove the item from current inventory.`))return;

  update({
   purchases:purchases.filter(item=>item.id!==p.id)
  });

  if(editingPurchaseId===p.id)resetPurchaseForm();
  notify('Purchase history record deleted.');
 }

 return <>
  <Heading
   eyebrow="CLUB ASSETS"
   title="Utilities & equipment"
   desc="Track existing club equipment and record new purchases."
  />

  <div className="two-col utilities-layout">
   <Panel
    title="Current utilities"
    desc="Items currently owned by the club"
   >
    <div className="utility-add-form">
     <label>
      Item name
      <input
       value={name}
       onChange={e=>setName(e.target.value)}
       placeholder="e.g. Drum"
      />
     </label>

     <label>
      Quantity
      <input
       type="number"
       min="1"
       value={qty}
       onChange={e=>setQty(e.target.value)}
      />
     </label>

     <label>
      Condition
      <select
       value={condition}
       onChange={e=>setCondition(e.target.value)}
      >
       <option>Good</option>
       <option>Needs repair</option>
       <option>Damaged</option>
      </select>
     </label>

     <button className="btn primary" onClick={add}>
      <Plus size={15}/> Add utility
     </button>
    </div>

    <div className="utility-list">
     {items.map(item=>
      <div className="utility-row" key={item.id}>
       <div>
        <b>{item.name}</b>
        <small>{item.condition||'Good'}</small>
       </div>

       <span>Qty {item.quantity}</span>

       <button
        className="icon-button danger"
        title="Remove utility"
        onClick={()=>
         update({
          utilities:items.filter(i=>i.id!==item.id)
         })
        }
       >
        <Trash2 size={15}/>
       </button>
      </div>
     )}

     {!items.length&&
      <p className="muted">No equipment recorded yet.</p>
     }
    </div>
   </Panel>

   <Panel
    title={editingPurchaseId?'Edit purchase':'Buy new utilities'}
    desc={
     editingPurchaseId
      ?'Update the selected purchase record.'
      :'Record a purchase and add the item to inventory.'
    }
   >
    <div className="purchase-form">
     <label>
      Item name
      <input
       value={purchase.name}
       onChange={e=>setPurchase({...purchase,name:e.target.value})}
       placeholder="Enter item name"
      />
     </label>

     <label>
      Quantity
      <input
       type="number"
       min="1"
       value={purchase.qty}
       onChange={e=>setPurchase({...purchase,qty:e.target.value})}
      />
     </label>

     <label>
      Total cost (RM)
      <input
       type="number"
       min="0"
       step="0.01"
       value={purchase.cost}
       onChange={e=>setPurchase({...purchase,cost:e.target.value})}
       placeholder="0.00"
      />
     </label>

     <label>
      Purchase date
      <input
       type="date"
       value={purchase.date}
       onChange={e=>setPurchase({...purchase,date:e.target.value})}
      />
     </label>

     <div className="purchase-form-actions">
      <button className="btn primary" onClick={buy}>
       {editingPurchaseId
        ?<><Save size={15}/> Save changes</>
        :<><Plus size={15}/> Record purchase</>
       }
      </button>

      {editingPurchaseId&&
       <button
        className="btn outline"
        onClick={resetPurchaseForm}
       >
        Cancel
       </button>
      }
     </div>
    </div>
   </Panel>
  </div>

  <Panel
   title="Purchase history"
   desc="Review and edit recorded equipment purchases."
  >
   <div className="table-wrap">
    <table>
     <thead>
      <tr>
       <th>ITEM</th>
       <th>DATE</th>
       <th>QUANTITY</th>
       <th>COST</th>
       <th>ACTION</th>
      </tr>
     </thead>

     <tbody>
      {purchases.map(p=>
       <tr key={p.id}>
        <td>{p.name}</td>
        <td>{p.date}</td>
        <td>{p.qty}</td>
        <td>{money(p.cost)}</td>
        <td>
         <button
          className="icon-button"
          title="Edit purchase"
          onClick={()=>editPurchase(p)}
         >
          <Pencil size={15}/>
         </button>
         <button
          className="icon-button danger"
          title="Delete purchase history"
          onClick={()=>removePurchase(p)}
         >
          <Trash2 size={15}/>
         </button>
        </td>
       </tr>
      )}
     </tbody>
    </table>

    {!purchases.length&&
     <p className="muted">No purchases recorded yet.</p>
    }
   </div>
  </Panel>
 </>;
}
function SettingsPage({data,update,notify}){
 const [club,setClub]=useState(data.clubName||'Lion Dance Club');
 const [roles,setRoles]=useState(data.roles||[]);
 const [name,setName]=useState('');
 const [rate,setRate]=useState('');

 useEffect(()=>{
  setClub(data.clubName||'Lion Dance Club');
  setRoles(data.roles||[]);
 },[data.clubName,data.roles]);

 function updateRole(id,patch){
  setRoles(current=>
   current.map(r=>r.id===id?{...r,...patch}:r)
  );
 }

 function addRole(){
  if(!name.trim()){
   notify('Please enter a role name.');
   return;
  }

  const amount=Number(rate);

  if(!Number.isFinite(amount)||amount<0){
   notify('Please enter a valid default salary.');
   return;
  }

  if(roles.some(r=>
   r.name.trim().toLowerCase()===name.trim().toLowerCase()
  )){
   notify('This role already exists.');
   return;
  }

  setRoles(current=>[
   ...current,
   {
    id:uid(),
    name:name.trim(),
    rate:amount
   }
  ]);

  setName('');
  setRate('');
 }

 function removeRole(id){
  const role=roles.find(r=>r.id===id);

  if(!role)return;

  if(!confirm(
   `Remove the role "${role.name}" from Settings? Historical event records will remain unchanged.`
  )){
   return;
  }

  setRoles(current=>current.filter(r=>r.id!==id));
 }

 function saveSettings(){
  if(!club.trim()){
   notify('Please enter your club name.');
   return;
  }

  if(roles.some(r=>!r.name.trim())){
   notify('Every role must have a name.');
   return;
  }

  update({
   clubName:club.trim(),
   roles:roles.map(r=>({
    ...r,
    name:r.name.trim(),
    rate:Number(r.rate||0)
   }))
  });

  notify('Settings saved.');
 }

 return <>
  <Heading
   eyebrow="PREFERENCES"
   title="Settings"
   desc="Manage your club information and default member salary rates."
  />

  <div className="settings-card">
   <div className="panel-head">
    <div>
     <h3>Club information</h3>
     <p>Set the name displayed in your management system.</p>
    </div>
   </div>

   <Field label="Club name">
    <input
     value={club}
     onChange={e=>setClub(e.target.value)}
     placeholder="Enter club name"
    />
   </Field>
  </div>

  <div className="settings-card">
   <div className="panel-head">
    <div>
     <h3>Default member salary rates</h3>
     <p>
      These rates are used when assigning a member to an event.
      You can still adjust an individual member's salary in an event.
     </p>
    </div>
   </div>

   <div className="table-wrap">
    <table>
     <thead>
      <tr>
       <th>ROLE</th>
       <th>DEFAULT SALARY (RM)</th>
       <th>ACTION</th>
      </tr>
     </thead>

     <tbody>
      {roles.map(r=>
       <tr key={r.id}>
        <td>
         <input
          value={r.name}
          onChange={e=>updateRole(r.id,{name:e.target.value})}
         />
        </td>

        <td>
         <input
          type="number"
          min="0"
          step="0.01"
          value={r.rate}
          onChange={e=>updateRole(r.id,{rate:e.target.value})}
         />
        </td>

        <td>
         <button
          className="icon-button danger"
          title="Remove role"
          onClick={()=>removeRole(r.id)}
         >
          <Trash2 size={15}/>
         </button>
        </td>
       </tr>
      )}
     </tbody>
    </table>
   </div>

   <div className="assignment-add">
    <input
     value={name}
     onChange={e=>setName(e.target.value)}
     placeholder="New role name"
    />

    <input
     type="number"
     min="0"
     step="0.01"
     value={rate}
     onChange={e=>setRate(e.target.value)}
     placeholder="Default salary (RM)"
    />

    <button className="btn outline" onClick={addRole}>
     <Plus size={15}/> Add role
    </button>
   </div>

   <p className="muted">
    Changing a default rate does not change salaries already recorded in historical events.
   </p>
  </div>

  <div className="settings-card">
   <div className="panel-head">
    <div>
     <h3>Account-based storage</h3>
     <p>
      Your club data is stored on the server and associated with your account.
     </p>
    </div>
    <Lock size={20}/>
   </div>

   <div className="account-note">
    <Lock size={17}/>
    <span>
     <b>Your club records are linked to your account.</b>
     <small>
      Sign in with your account to access your club information.
     </small>
    </span>
   </div>
  </div>

  <div className="modal-actions">
   <button className="btn primary" onClick={saveSettings}>
    <Save size={16}/> Save settings
   </button>
  </div>
 </>;
}
export default App;