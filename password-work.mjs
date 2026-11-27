// Password login waits only inside this process. No secrets or timers are persisted.
// The general password/portable-work pool keeps its existing hard cap of four;
// login uses at most three lanes so unrelated immediate work can still enter.
const BUSY='Server busy. Try again shortly.';
const busy=(retryAfter)=>Object.assign(Error(BUSY),{status:429,retryAfter});
const cancelled=()=>Object.assign(Error('Request ended.'),{status:499});

export function createPasswordWorkGate({maxQueued=32,maxPerPeer=28,waitMs=8000}={}){
  let running=0,logins=0,waiting=0,closed=false;
  const queue=new Map();
  const remove=job=>{
    const peers=queue.get(job.peer);
    if(!peers)return false;
    const i=peers.indexOf(job);if(i<0)return false;
    peers.splice(i,1);waiting--;
    if(!peers.length)queue.delete(job.peer);
    return true;
  };
  function clear(job){
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort',job.abort);
  }
  function fail(job,error){
    if(!remove(job))return;
    clear(job);job.work=null;job.reject(error);
  }
  function pump(){
    while(!closed&&waiting&&running<4&&logins<3){
      const [peer,batch]=queue.entries().next().value,job=batch.shift();
      waiting--;queue.delete(peer);if(batch.length)queue.set(peer,batch);
      clear(job);
      if(job.signal?.aborted){job.work=null;job.reject(cancelled());continue;}
      if(performance.now()>=job.startBy){job.work=null;job.reject(busy(2));continue;}
      const fn=job.work;job.work=null;running++;logins++;
      void (async()=>{
        try{job.resolve(await fn());}catch(e){job.reject(e);}
        finally{logins--;running--;pump();}
      })();
    }
  }
  function login(peer,work,signal){
    if(signal?.aborted)return Promise.reject(cancelled());
    if(closed||waiting>=maxQueued||(queue.get(peer)?.length||0)>=maxPerPeer)return Promise.reject(busy(2));
    return new Promise((resolve,reject)=>{
      const job={peer,work,signal,resolve,reject,startBy:performance.now()+waitMs};
      job.abort=()=>fail(job,cancelled());
      job.timer=setTimeout(()=>{fail(job,busy(2));pump();},waitMs);
      job.timer.unref();
      signal?.addEventListener('abort',job.abort,{once:true});
      if(!queue.has(peer))queue.set(peer,[]);
      queue.get(peer).push(job);waiting++;
      pump();
    });
  }
  async function immediate(work){
    if(closed||running>=4)throw busy();
    running++;
    try{return await work();}finally{running--;pump();}
  }
  function close(){
    closed=true;
    for(const batch of [...queue.values()])for(const job of [...batch])fail(job,busy(2));
  }
  return {login,immediate,close};
}
