export function dualModelSettings(env:NodeJS.ProcessEnv=process.env){
  const root=env.GEMMA_API_URL?.replace(/\/$/,'');
  const baseUrl=env.HOP_DUAL_MODEL_URL||env.OPENAI_BASE_URL||(root?root+'/v1':'http://127.0.0.1:18021/v1');
  const protocol=env.HOP_DUAL_PROTOCOL||(env.OLLAMA_MODEL?'ollama':'llamacpp');
  if(!['ollama','llamacpp'].includes(protocol))throw new Error('HOP_DUAL_PROTOCOL must be ollama or llamacpp');
  return {
    modelId:env.HOP_DUAL_MODEL_ID||env.OLLAMA_MODEL||'',
    checkpointSha256:env.HOP_DUAL_MODEL_SHA256||'',
    baseUrl,evaluatorUrl:env.HOP_DUAL_EVALUATOR_URL||baseUrl,responderUrl:env.HOP_DUAL_RESPONDER_URL||baseUrl,
    apiKey:env.HOP_DUAL_API_KEY||env.OPENAI_API_KEY||'',
    profile:env.HOP_DUAL_PROMPT_PROFILE||'test',version:env.HOP_DUAL_PROMPT_VERSION||'v1',
    protocol:protocol as 'ollama'|'llamacpp',
    allowedOrigins:(env.HOP_MODEL_ALLOWED_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean),
  };
}
