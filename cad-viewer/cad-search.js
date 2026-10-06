(() => {
  const style = document.createElement('style');
  style.textContent = `
    #feederCadSearch{position:absolute;z-index:80;top:8px;left:50%;transform:translateX(-50%);display:flex;gap:6px;align-items:center;width:min(560px,calc(100% - 20px));padding:7px;background:rgba(17,24,39,.94);border:1px solid #475569;border-radius:10px;box-shadow:0 5px 18px rgba(0,0,0,.35)}
    #feederCadSearch input{flex:1;min-width:0;padding:9px 11px;border-radius:7px;border:1px solid #64748b;background:#fff;color:#111827;font-size:14px;direction:ltr}
    #feederCadSearch button{border:0;border-radius:7px;padding:9px 12px;background:#087f5b;color:#fff;font-weight:700;cursor:pointer}
    #feederCadSearch span{color:#e5e7eb;font-size:12px;white-space:nowrap}
    @media(max-width:600px){#feederCadSearch{top:5px}#feederCadSearch span{display:none}}
  `;
  document.head.appendChild(style);
  const box = document.createElement('div');
  box.id = 'feederCadSearch';
  box.innerHTML = '<input id="feederCadSearchInput" placeholder="🔎 ابحث داخل الرسم مثل F-8.13" autocomplete="off"><button id="feederCadSearchBtn">بحث</button><span id="feederCadSearchStatus">جاهز</span>';
  const host = document.querySelector('.viewer-canvas-area') || document.body;
  host.appendChild(box);
  let occurrence = 0;
  function runSearch(reset=true){
    const input=document.getElementById('feederCadSearchInput');
    const status=document.getElementById('feederCadSearchStatus');
    if(reset) occurrence=0;
    const result=window.cadViewerSearch?.(input.value, occurrence);
    if(!result?.found){status.textContent='لم يتم العثور';return;}
    occurrence=result.index;
    status.textContent=(result.index+1)+'/'+result.count+'  '+result.text;
  }
  document.getElementById('feederCadSearchBtn').onclick=()=>runSearch(true);
  document.getElementById('feederCadSearchInput').addEventListener('keydown',e=>{if(e.key==='Enter')runSearch(true)});
  document.getElementById('feederCadSearchInput').addEventListener('input',()=>{occurrence=0});
})();
