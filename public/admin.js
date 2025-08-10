const tbody = document.querySelector('#faqTable tbody');
const fileEl = document.getElementById('file');
const appendEl = document.getElementById('append');
const urlInput = document.getElementById('urlInput');

function row(faq={title:'',question:'',answer:'',tags:[]}){
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input value="${faq.title||''}"></td>
    <td><textarea rows="2">${faq.question||''}</textarea></td>
    <td><textarea rows="3">${faq.answer||''}</textarea></td>
    <td><input value="${(faq.tags||[]).join('|')}"></td>
    <td class="actions"><button class="del">Delete</button></td>
  `;
  tr.querySelector('.del').onclick=()=>tr.remove();
  return tr;
}

async function load(){
  const res = await fetch('/api/faq');
  const data = await res.json();
  tbody.innerHTML = '';
  (data.items||[]).forEach(f=> tbody.appendChild(row(f)));
}

async function save(){
  const items = [...tbody.querySelectorAll('tr')].map(tr=>{
    const [titleEl, qEl, aEl, tEl] = tr.querySelectorAll('input,textarea');
    return { title:titleEl.value.trim(), question:qEl.value.trim(), answer:aEl.value.trim(), tags: tEl.value.split('|').map(s=>s.trim()).filter(Boolean)};
  });
  const res = await fetch('/api/faq', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({items}) });
  const data = await res.json();
  alert(data.ok? 'Saved' : 'Error saving');
}

async function importFile(){
  if (!fileEl.files.length) return alert('Choose a file');
  const fd = new FormData();
  fd.append('file', fileEl.files[0]);
  const res = await fetch(`/api/faq/import?append=${appendEl.checked}`, { method:'POST', body: fd });
  const data = await res.json();
  if (data.error) return alert('Import error: ' + data.error);
  await load();
  alert('Imported');
}

document.getElementById('addRow').onclick = ()=> tbody.appendChild(row());
document.getElementById('saveBtn').onclick = save;
document.getElementById('importBtn').onclick = importFile;
document.getElementById('importPdfBtn').onclick = async ()=>{
  if (!fileEl.files.length) return alert('Choose a PDF file');
  const file = fileEl.files[0];
  if (!/pdf$/i.test(file.name)) return alert('Select a .pdf file');
  const fd = new FormData(); fd.append('file', file);
  const res = await fetch(`/api/faq/import/pdf?append=${appendEl.checked}`, { method:'POST', body: fd });
  const data = await res.json();
  if (data.error) return alert('PDF import error: ' + data.error);
  await load();
  alert('Imported from PDF');
};
document.getElementById('importUrlBtn').onclick = async ()=>{
  const url = (urlInput?.value || '').trim();
  if (!url) return alert('Enter a URL');
  const res = await fetch(`/api/faq/import/url?append=${appendEl.checked}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url }) });
  const data = await res.json();
  if (data.error) return alert('URL import error: ' + data.error);
  await load();
  alert('Imported from URL');
};
document.getElementById('exportBtn').onclick = async ()=>{
  const res = await fetch('/api/faq');
  const data = await res.json();
  const blob = new Blob([JSON.stringify(data.items||[], null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'faq.json'; a.click();
};

load();
