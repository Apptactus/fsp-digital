// Backend FSP Digital — roda no servidor, a chave NUNCA vai para o celular.
// Variáveis de ambiente na Vercel:
//   GEMINI_API_KEY  (obrigatória)  — a chave do Google AI Studio
//   GEMINI_MODELO   (opcional)     — modelo a usar, ex: gemini-flash-latest
//   FSP_DETALHE     (opcional)     — "1" mostra o erro técnico na tela do app

const SYSTEM_PROMPT = `Você é um especialista em engenharia de manutenção, confiabilidade e análise de causa raiz (MASP / Kaizen / Ishikawa / 5 Porquês) para ambiente industrial.

ENTRADA: você recebe dados já preenchidos por um técnico (problema, descrição, se é falha repetida, ação corretiva já tomada, ação preventiva pensada - pode vir vazia).

SUA TAREFA:
1. Classifique as possíveis causas em 4 categorias: MATERIAL, MÁQUINA, MÉTODO, MÃO DE OBRA. Se não houver evidência para uma categoria, use exatamente "NA".
2. Rode mentalmente a cadeia de 5 Porquês partindo do sintoma até a causa raiz de processo/gestão, e valide com a lógica "Portanto" em sentido inverso. Retorne a cadeia dos 5 porquês de forma resumida.
3. Avalie a(s) ação(ões) que o técnico já informou: elas atacam a causa raiz encontrada, ou só o sintoma?
4. Gere EXATAMENTE 2 ações, nunca mais nem menos. Para cada ação, VOCÊ decide o tipo: "MITIGAÇÃO IMEDIATA" (contém o problema agora) ou "RESOLUÇÃO DEFINITIVA" (elimina a causa raiz). Não é obrigatório ser uma de cada — se a causa raiz exigir 2 ações estruturais, as 2 podem ser "RESOLUÇÃO DEFINITIVA"; se só for possível conter o problema por ora, as 2 podem ser "MITIGAÇÃO IMEDIATA". A decisão é sua, baseada na análise, nunca um padrão fixo.
5. Não copie literalmente a ação que o técnico já escreveu — construa/refine a partir da causa raiz encontrada.
6. Se a descrição for vaga demais para uma causa raiz confiável, dê a melhor hipótese técnica e marque "hipotese": true.

RESPONDA ESTRITAMENTE EM JSON VÁLIDO, SEM markdown, SEM texto fora do JSON, seguindo exatamente este schema:
{
  "quatro_m": {"material": "string ou NA", "maquina": "string ou NA", "metodo": "string ou NA", "mao_de_obra": "string ou NA"},
  "cinco_porques": ["1º porquê", "2º porquê", "3º porquê", "4º porquê", "5º porquê"],
  "causa_raiz": "string concisa e técnica",
  "hipotese": false,
  "analise_acoes_tecnico": "1 frase curta avaliando o que o técnico já informou (ou 'Técnico não informou ação prévia.' se vazio)",
  "acoes": [
    {"tipo": "MITIGAÇÃO IMEDIATA ou RESOLUÇÃO DEFINITIVA", "texto": "string"},
    {"tipo": "MITIGAÇÃO IMEDIATA ou RESOLUÇÃO DEFINITIVA", "texto": "string"}
  ],
  "status_sugerido": "Em análise ou Corrigido ou Em monitoramento"
}

Seja extremamente conciso, técnico e direto. Linguagem de manutenção industrial.`;

// ── Orçamento de tempo ──────────────────────────────────────────────
// A Vercel mata a function em 60s sem avisar o app (o técnico vê tela
// travada). Então o backend se controla: nunca passa de ORCAMENTO_MS,
// e cada chamada ao Google tem prazo próprio (TIMEOUT_CHAMADA_MS).
const ORCAMENTO_MS = 45000;        // teto total do handler
const TIMEOUT_CHAMADA_MS = 18000;  // teto de UMA chamada ao Google
const ESPERA_FILA_MS = 3000;       // espera curta quando o Google está em fila

// Modelos em ordem de preferência. GEMINI_MODELO (env) entra na frente.
const MODELOS_PADRAO = ['gemini-flash-latest', 'gemini-2.0-flash', 'gemini-flash-lite-latest'];

// fetch com prazo: aborta sozinho em vez de pendurar a function até os 60s
async function fetchComPrazo(url, opcoes, prazoMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), prazoMs);
  try {
    return await fetch(url, { ...opcoes, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  // CORS — permite o app chamar este backend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ erro: 'Servidor sem chave configurada. Defina GEMINI_API_KEY.' });
  }

  // Mostra o motivo técnico na tela do app quando FSP_DETALHE=1
  const mostrarDetalhe = process.env.FSP_DETALHE === '1';
  const responder = (status, msg, detalhe) => {
    const corpo = { erro: msg };
    if (mostrarDetalhe && detalhe) corpo.detalhe = String(detalhe).slice(0, 300);
    return res.status(status).json(corpo);
  };

  const inicio = Date.now();
  const restante = () => ORCAMENTO_MS - (Date.now() - inicio);

  try {
    const d = req.body || {};

    if (!d.problema || !d.descricao) {
      return res.status(400).json({ erro: 'Informe ao menos o problema e a descrição.' });
    }

    const userMsg = `DATA: ${d.data || 'não informado'}
LINHA: ${d.linha || 'não informado'}
TAG: ${d.tag || 'não informado'}
FALHA REPETIDA: ${d.repete ? 'Sim, ' + (d.vezes || '?') + ' vezes, período: ' + (d.periodo || 'não informado') : 'Não'}

PROBLEMA: ${d.problema}

DESCRIÇÃO: ${d.descricao}

AÇÃO CORRETIVA JÁ TOMADA PELO TÉCNICO: ${d.corretiva || 'não informada'}

AÇÃO PREVENTIVA PENSADA PELO TÉCNICO: ${d.preventiva || 'não informada'}`;

    const modeloEnv = (process.env.GEMINI_MODELO || '').trim();
    const MODELOS = modeloEnv
      ? [modeloEnv, ...MODELOS_PADRAO.filter(m => m !== modeloEnv)]
      : MODELOS_PADRAO;

    const promptCompleto = SYSTEM_PROMPT + '\n\n=== DADOS DA OCORRÊNCIA ===\n\n' + userMsg;

    const corpo = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: promptCompleto }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json'
      }
    });

    let gemResp = null, raw = '', modeloUsado = null;
    let ultimoStatus = 0, ultimoMotivo = '';

    busca:
    for (const modelo of MODELOS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;

      for (let tentativa = 1; tentativa <= 2; tentativa++) {
        // Só começa uma chamada se couber no orçamento restante
        if (restante() < TIMEOUT_CHAMADA_MS + 2000) {
          ultimoMotivo = ultimoMotivo || 'orçamento de tempo esgotado antes da tentativa';
          console.warn('Tempo insuficiente para nova tentativa. Restante:', restante(), 'ms');
          break busca;
        }

        const prazo = Math.min(TIMEOUT_CHAMADA_MS, restante() - 2000);

        try {
          gemResp = await fetchComPrazo(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: corpo
          }, prazo);
          raw = await gemResp.text();
        } catch (e) {
          const abortado = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
          ultimoStatus = 0;
          ultimoMotivo = abortado
            ? `${modelo}: sem resposta do Google em ${Math.round(prazo / 1000)}s`
            : `${modelo}: falha de rede — ${e.message}`;
          console.warn('Tentativa falhou:', ultimoMotivo);
          gemResp = null;
          continue; // tenta de novo (ou cai para o próximo modelo)
        }

        if (gemResp.ok) { modeloUsado = modelo; break busca; }

        ultimoStatus = gemResp.status;
        ultimoMotivo = `${modelo}: HTTP ${gemResp.status} — ${raw.slice(0, 200)}`;

        // Modelo indisponível / chave sem acesso: passa para o próximo da lista
        if (gemResp.status === 404 || gemResp.status === 403) {
          console.warn(`Modelo ${modelo} indisponível (${gemResp.status}), tentando o próximo.`);
          break;
        }

        // Fila/limite: espera curta e tenta de novo, se couber no orçamento
        if (gemResp.status === 429 || gemResp.status === 503) {
          if (tentativa >= 2 || restante() < TIMEOUT_CHAMADA_MS + ESPERA_FILA_MS + 2000) break busca;
          console.warn(`Fila na API (${modelo}), aguardando ${ESPERA_FILA_MS}ms`);
          await new Promise(r => setTimeout(r, ESPERA_FILA_MS));
          continue;
        }

        break busca; // outro erro: não adianta insistir
      }
    }

    if (modeloUsado) {
      console.log(`Análise gerada com ${modeloUsado} em ${Date.now() - inicio}ms`);
    }

    // Nenhuma resposta utilizável
    if (!gemResp || !gemResp.ok) {
      console.error('Falha ao obter análise. Motivo:', ultimoMotivo, '| decorrido:', Date.now() - inicio, 'ms');

      let msg;
      if (ultimoStatus === 429) {
        msg = 'Serviço com fila no momento. Aguarde alguns segundos e tente novamente.';
      } else if (ultimoStatus === 403) {
        msg = 'A chave do servidor foi recusada pelo provedor. Verifique a chave e a cota.';
      } else if (ultimoStatus === 404) {
        msg = 'Nenhum modelo de análise disponível para esta chave.';
      } else if (ultimoStatus === 0) {
        msg = 'O serviço de análise demorou demais para responder. Tente novamente.';
      } else {
        msg = 'A análise não pôde ser concluída no momento.';
      }
      return responder(502, msg, ultimoMotivo);
    }

    let gemData;
    try {
      gemData = JSON.parse(raw);
    } catch (e) {
      console.error('Resposta não-JSON do Gemini:', raw.slice(0, 500));
      return responder(502, 'Resposta inesperada do serviço de análise.', raw.slice(0, 200));
    }

    const cand = gemData?.candidates?.[0];
    const partes = cand?.content?.parts;
    const texto = Array.isArray(partes)
      ? partes.map(p => p?.text || '').join('')
      : (partes?.[0]?.text || '');

    if (!texto) {
      console.error('Sem texto. finishReason:', cand?.finishReason, '| resposta:', JSON.stringify(gemData).slice(0, 800));
      return responder(502, 'O serviço de análise não retornou conteúdo.', 'finishReason: ' + (cand?.finishReason || 'desconhecido'));
    }

    let limpo = texto.replace(/```json/gi, '').replace(/```/g, '').trim();
    const ini = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (ini === -1 || fim === -1 || fim <= ini) {
      console.error('Texto sem JSON válido. finishReason:', cand?.finishReason, '| texto:', texto.slice(0, 800));
      return responder(502, 'A análise veio em formato não reconhecido.', 'finishReason: ' + (cand?.finishReason || '?'));
    }
    limpo = limpo.slice(ini, fim + 1);

    let analise;
    try {
      analise = JSON.parse(limpo);
    } catch (e) {
      console.error('JSON inválido. finishReason:', cand?.finishReason, '| conteudo:', limpo.slice(0, 800));
      return responder(502, 'A análise veio incompleta. Tente novamente.', 'JSON inválido | finishReason: ' + (cand?.finishReason || '?'));
    }

    // Normaliza o resultado para o app nunca quebrar por campo ausente
    const m = analise.quatro_m || analise['4m'] || {};
    analise.quatro_m = {
      material: m.material || 'NA',
      maquina: m.maquina || m['máquina'] || 'NA',
      metodo: m.metodo || m['método'] || 'NA',
      mao_de_obra: m.mao_de_obra || m['mão_de_obra'] || 'NA'
    };

    if (!analise.causa_raiz) {
      console.error('Sem causa_raiz:', JSON.stringify(analise).slice(0, 500));
      return responder(502, 'A análise veio incompleta. Tente novamente.', 'resposta sem causa_raiz');
    }

    if (!Array.isArray(analise.acoes) || analise.acoes.length === 0) {
      console.error('Sem ações:', JSON.stringify(analise).slice(0, 500));
      return responder(502, 'A análise veio incompleta. Tente novamente.', 'resposta sem ações');
    }

    analise.acoes = analise.acoes.slice(0, 2).map(a => ({
      tipo: a.tipo || 'AÇÃO RECOMENDADA',
      texto: a.texto || a.acao || a.descricao || ''
    }));

    if (!Array.isArray(analise.cinco_porques)) analise.cinco_porques = [];
    if (!analise.analise_acoes_tecnico) analise.analise_acoes_tecnico = '—';
    if (!analise.status_sugerido) analise.status_sugerido = 'Em análise';
    analise.hipotese = !!analise.hipotese;

    return res.status(200).json(analise);

  } catch (err) {
    console.error('Falha no handler:', err);
    return responder(500, 'Falha interna ao processar a análise.', err && err.message);
  }
}
