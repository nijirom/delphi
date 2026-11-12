import { createInterface } from 'node:readline';

export type ApprovalConfig = { apiKey?: string; agentId?: string; phoneId?: string; to?: string };
export type ApprovalRequest = { symbol:string; side:string; size:number; edge:number };
const sleep = (ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function terminal(r: ApprovalRequest): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({input:process.stdin,output:process.stdout});
  return new Promise(resolve=> {
    let finished = false;
    const done = (v:boolean)=>{ if (finished) return; finished=true; clearTimeout(timer); rl.close(); resolve(v); };
    const timer = setTimeout(()=>done(false),60000);
    rl.once('close',()=>done(false));
    rl.question(`Approve ${r.side} ${JSON.stringify(r.symbol)} up to $${r.size.toFixed(6)} (edge ${r.edge.toFixed(4)})? Type yes: `,answer=>done(answer.trim().toLowerCase()==='yes'));
  });
}
export async function approve(config: ApprovalConfig,r:ApprovalRequest): Promise<boolean> {
  if (!config.apiKey || !config.agentId || !config.phoneId || !config.to) return terminal(r);
  const deadline = Date.now()+180000;
  const call = async (path:string,body?:unknown):Promise<Record<string,unknown>>=> {
    const remaining = deadline-Date.now();
    if (remaining<=0) throw new Error('Approval timeout');
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/${path}`,{
      method:body ? 'POST':'GET', headers:{'xi-api-key':config.apiKey!,'Content-Type':'application/json'},
      ...(body ? {body:JSON.stringify(body)}:{}), redirect:'error',signal:AbortSignal.timeout(Math.min(15000,remaining))
    });
    if (!response.ok) throw new Error('Approval provider unavailable');
    return await response.json() as Record<string,unknown>;
  };
  try {
    const result = await call('twilio/outbound-call',{agent_id:config.agentId,agent_phone_number_id:config.phoneId,to_number:config.to,conversation_initiation_client_data:{dynamic_variables:{symbol:r.symbol,side:r.side,size:r.size,edge:r.edge}}});
    if (result.success !== true || typeof result.conversation_id !== 'string') return false;
    while (Date.now()<deadline) {
      const conversation = await call(`conversations/${encodeURIComponent(result.conversation_id)}`);
      if (conversation.status==='failed') return false;
      if (conversation.status==='done') {
        const analysis = conversation.analysis as {data_collection_results?:{approved?:{value?:unknown}}}|undefined;
        return analysis?.data_collection_results?.approved?.value === true;
      }
      await sleep(Math.min(3000,Math.max(0,deadline-Date.now())));
    }
  } catch { return false; }
  return false;
}
