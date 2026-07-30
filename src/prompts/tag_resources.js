export function TAG_RESOURCES_PROMPT(project, resources, guidelineContext, assessmentContext) {
  return `Sei un esperto FinOps e cloud architect. Devi assegnare tag AWS alle risorse di seguito, seguendo la tagging strategy di CINECA.

## Contesto progetto
- Account AWS: ${project.accountId}
- Regione: ${project.region || 'eu-west-1'}
- Nome progetto: ${project.name}

## Tagging Strategy e linee guida
${guidelineContext || 'Non disponibile. Usa best practice FinOps standard.'}

## Contesto assessment (risorse on-prem / cloud ipotizzate)
${assessmentContext || 'Non disponibile.'}

## Risorse da taggare
${JSON.stringify(resources, null, 2)}

## Istruzioni
Per ogni risorsa assegna i tag nel namespace "cineca:" (es. cineca:env, cineca:product, cineca:team, cineca:cost-center, cineca:tier, cineca:managed-by).
Usa anche i tag AWS standard dove appropriato (Name, Environment, Project).

Per ogni risorsa indica:
- i tag proposti come oggetto JSON
- confidence: numero tra 0 e 1 (1 = certissimo, 0.5 = incerto)
- status: "tagged" se confidence >= 0.7, "uncertain" se < 0.7
- reasoning: breve spiegazione (max 2 righe)

Rispondi con un array JSON e nient'altro:
[
  {
    "resourceId": "uuid-della-risorsa",
    "tags": { "cineca:env": "prod", "cineca:product": "identity", ... },
    "confidence": 0.9,
    "status": "tagged",
    "reasoning": "..."
  },
  ...
]`;
}
