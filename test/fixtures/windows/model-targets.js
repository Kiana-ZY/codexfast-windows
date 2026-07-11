"list-models-for-host":Q7((e,{priority:t,source:n,timeoutMs:r,...i})=>e.sendRequest(`model/list`,i,{priority:t,source:n,timeoutMs:r}));
use_hidden_models;select:({data:r})=>Jv({authMethod:t,availableModels:new Set(e),defaultModel:n,enabledReasoningEfforts:c,includeUltraReasoningEffort:l,models:r,useHiddenModels:o})
