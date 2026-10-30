import { state } from './admin-state.js';
import {templateBuilderState,invoiceRequest,previewPdfOrder,clearPdfTemplate} from './admin-dispatch-template.js';

let forms=[],owner='',generation=0;
const account=()=>sessionStorage.getItem('deliveryProDispatchKey')||'';
function drawForms(){
 const list=document.getElementById('saved-forms-list');if(!list)return;list.replaceChildren();
 if(!forms.length){list.textContent=localStorage.getItem('deliveryPro_savedForms')?'기존 양식은 원본 PDF를 한 번 다시 등록해 주세요. 이전 저장 자료는 유지됩니다.':'저장된 양식이 없습니다. 원본 PDF를 등록해 주세요.';return;}
 forms.forEach((form,idx)=>{const row=document.createElement('div');row.className='border rounded-xl p-3 flex gap-2 items-center bg-white';
  const select=document.createElement('button');select.className='flex-1 text-left text-xs';select.textContent=(form.id===templateBuilderState.activeTemplateId?'✓ ':'')+form.title+(form.isDefault?' · 기본양식':'');select.onclick=()=>applySavedForm(idx);row.appendChild(select);
  for(const [label,handler] of [['★',()=>setAsDefaultForm(idx)],['삭제',()=>deleteSavedForm(idx)]]){const button=document.createElement('button');button.textContent=label;button.className='text-xs p-1';button.onclick=handler;row.appendChild(button);}list.appendChild(row);
 });
}
export async function loadSavedForms(){
 const current=account(),version=++generation;
 if(current!==owner){owner=current;forms=[];clearPdfTemplate();}
 try{const result=await invoiceRequest({action:'list'});if(current!==account()||version!==generation)return;forms=result.templates;drawForms();
  if(!templateBuilderState.activeTemplateId){const index=forms.findIndex(f=>f.isDefault);if(index>=0)await applySavedForm(index);}
 }catch(e){if(version!==generation)return;const list=document.getElementById('saved-forms-list');if(list)list.textContent=e.message;}
}
export async function applySavedForm(idx){
 const form=forms[idx];if(!form||owner!==account())return;
 templateBuilderState.activeTemplateId=form.id;templateBuilderState.activeTemplateTitle=form.title;templateBuilderState.currentDocHtml='';state.currentSelectedFormIndex=idx;drawForms();
 try{await previewPdfOrder(state.printReadyList?.[state.currentPreviewInvoiceIndex||0]);}catch(e){alert(e.message);}
}
export async function setAsDefaultForm(idx){const form=forms[idx];if(!form||owner!==account())return;try{await invoiceRequest({action:'default',id:form.id});await loadSavedForms();}catch(e){alert(e.message);}}
export async function deleteSavedForm(idx){const form=forms[idx];if(!form||owner!==account()||!confirm('['+form.title+'] 양식을 삭제하시겠습니까?'))return;try{await invoiceRequest({action:'delete',id:form.id});if(templateBuilderState.activeTemplateId===form.id)clearPdfTemplate();await loadSavedForms();}catch(e){alert(e.message);}}
export function toggleSelectForm(idx){return applySavedForm(idx);}
export function previewSavedForm(idx){return applySavedForm(idx);}
export function saveProviderForm(){return window.saveCurrentDocumentTemplate?.();}
export function cancelProviderFormEdit(){state.currentSelectedFormIndex=null;clearPdfTemplate();drawForms();}
export function updateLivePreview(){}
export function syncPreviewData(){}
Object.assign(window,{loadSavedForms,applySavedForm,setAsDefaultForm,deleteSavedForm,toggleSelectForm,previewSavedForm,saveProviderForm,cancelProviderFormEdit,updateLivePreview,syncPreviewData});
