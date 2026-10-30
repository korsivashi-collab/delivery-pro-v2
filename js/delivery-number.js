// Both registration paths use the same server allocator; retries keep their delivery ID.
export async function assignDeliveryNumbers(items, request) {
 const pending=items.filter(item=>!item.deliveryNumber);
 for(const item of pending)if(!item.deliveryId)item.deliveryId=crypto.randomUUID();
 for(let offset=0;offset<pending.length;offset+=100){
  const batch=pending.slice(offset,offset+100),result=await request(batch.map(item=>item.deliveryId));
  const numbers=new Map((result.deliveries||[]).map(d=>[d.deliveryId,d.deliveryNumber]));
  if(batch.some(item=>!/^[A-Za-z0-9]{5}$/.test(numbers.get(item.deliveryId)||'')))throw Error('배송번호 발급 결과를 확인하지 못했습니다.');
  for(const item of batch)item.deliveryNumber=numbers.get(item.deliveryId);
 }
 return items;
}
