# FSP Digital — Guia de Instalação

App de análise de falhas (Ishikawa 4M + 5 Porquês) com IA rodando **oculta no servidor**.
O técnico não vê nenhuma IA: preenche o formulário, recebe o relatório e baixa o PDF.

---

## Arquitetura

```
Celular (index.html)  →  Seu backend na Vercel  →  API Gemini
     formulário            (guarda a chave)          (análise)
        ↑                                                 |
        └───────────── relatório + PDF ←──────────────────┘
```

A chave da API fica **só no servidor**. Nunca chega ao celular, não aparece no código do app,
não pode ser extraída por ninguém que use o aplicativo.

---

## PASSO 1 — Criar a chave do Gemini (grátis)

1. Acesse **https://aistudio.google.com/apikey**
2. Faça login com sua conta Google.
3. Clique em **Create API key** → **Create API key in new project**.
4. Copie a chave (algo como `AIzaSy...`) e guarde. Não compartilhe com ninguém.

> A camada gratuita do Gemini cobre folgadamente o uso de uma equipe de manutenção.

---

## PASSO 2 — Publicar o backend na Vercel

### 2.1 Criar a conta
1. Acesse **https://vercel.com/signup** e crie conta (pode usar o login do GitHub ou e-mail).

### 2.2 Subir o projeto
**Opção A — pelo GitHub (recomendado, permite atualizar depois):**
1. Crie um repositório novo no GitHub.
2. Suba estes arquivos mantendo a estrutura:
   ```
   /api/analisar.js
   /index.html
   /vercel.json
   ```
3. Na Vercel: **Add New → Project → Import** o repositório → **Deploy**.

**Opção B — arrastar e soltar:**
1. Compacte a pasta do projeto em `.zip`.
2. Na Vercel, use **Add New → Project → Deploy** e arraste o `.zip`.

### 2.3 Configurar a chave (passo essencial)
1. No projeto da Vercel, vá em **Settings → Environment Variables**.
2. Adicione:
   - **Name:** `GEMINI_API_KEY`
   - **Value:** a chave copiada no Passo 1
   - **Environments:** marque Production, Preview e Development
3. Clique em **Save**.
4. Vá em **Deployments** → nos três pontinhos do último deploy → **Redeploy**.
   (Sem esse redeploy, a chave não entra em vigor.)

### 2.5 Variáveis opcionais (só se precisar)
Mesma tela de Environment Variables:

| Name | Value | Para que serve |
|---|---|---|
| `GEMINI_MODELO` | ex: `gemini-flash-latest` | Força um modelo específico. Sem ela, o sistema testa os modelos em ordem até achar um disponível. Útil se o Google mudar nomes de modelo — você troca aqui, sem mexer no código. |
| `FSP_DETALHE` | `1` | Mostra o motivo técnico do erro na tela do app, entre colchetes. Ligue para investigar um problema, desligue (ou apague a variável) depois. |

> Depois de criar ou mudar qualquer variável, faça o **Redeploy** do passo 2.4.

### 2.4 Anotar a URL
A Vercel vai te dar um endereço, por exemplo:
```
https://fsp-digital.vercel.app
```
O endereço do backend é esse + `/api/analisar`:
```
https://fsp-digital.vercel.app/api/analisar
```

---

## PASSO 3 — Conectar o app ao backend

1. Abra o `index.html` em qualquer editor de texto.
2. Localize, logo no início do `<script>`, a linha:
   ```js
   const BACKEND_URL = "COLE_AQUI_A_URL_DO_SEU_BACKEND";
   ```
3. Substitua pelo seu endereço:
   ```js
   const BACKEND_URL = "https://fsp-digital.vercel.app/api/analisar";
   ```
4. Salve e suba o arquivo atualizado (novo commit no GitHub, ou novo deploy).

Pronto: o app já está em `https://fsp-digital.vercel.app`.

---

## PASSO 4 — Instalar no celular

**iPhone (Safari):** abra o endereço → botão Compartilhar → **Adicionar à Tela de Início**.

**Android (Chrome):** abra o endereço → menu ⋮ → **Instalar aplicativo** / **Adicionar à tela inicial**.

O ícone fica junto dos outros apps e abre em tela cheia, sem barra de navegador.

---

## Uso diário

1. Técnico preenche: data, linha, TAG, problema, descrição, se repetiu, e o que já fez.
2. Toca em **Gerar Análise**.
3. Recebe: 4M preenchido, cadeia dos 5 Porquês, causa raiz, avaliação do que ele fez, e **2 ações**
   (o sistema decide se cada uma é *mitigação imediata* ou *resolução definitiva*).
4. Toca em **Baixar PDF** — relatório formatado, pronto para anexar na OS ou enviar.
5. Tudo fica salvo na aba **Histórico**, no próprio aparelho.

---

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| "Backend não configurado" | `BACKEND_URL` não editada | Refaça o Passo 3 |
| "Servidor sem chave configurada" | Variável não criada ou sem redeploy | Refaça o Passo 2.3, incluindo o Redeploy |
| "Servidor respondeu em formato inesperado" | URL do backend errada | Confira se termina em `/api/analisar` |
| "O serviço de análise demorou demais" | O Google não respondeu dentro do prazo | Tente de novo. Se insistir, defina `GEMINI_MODELO` com outro modelo (passo 2.5) |
| "A chave do servidor foi recusada" | Chave inválida, revogada ou cota estourada | Gere nova chave no AI Studio e atualize `GEMINI_API_KEY` + Redeploy |
| "Nenhum modelo de análise disponível" | A chave não tem acesso a nenhum dos modelos da lista | Confira a chave; ou defina `GEMINI_MODELO` com um modelo que sua conta tenha |
| "Serviço com fila no momento" | Limite de requisições do plano gratuito | Aguarde alguns segundos e repita |
| "A análise não pôde ser concluída" | Outro erro do provedor | Ligue `FSP_DETALHE=1` (passo 2.5) para ver o motivo na tela, ou veja Vercel → Logs |
| Erro só no celular, funciona no PC | Cache do navegador | Feche a aba e reabra, ou limpe os dados do site |

Os logs detalhados ficam em **Vercel → seu projeto → Logs**. Nenhum erro técnico é exibido ao
técnico no celular — ele vê só mensagens em português, simples.

---

## Custos

- **Vercel:** plano Hobby gratuito atende esse uso.
- **Gemini:** camada gratuita no AI Studio; acima disso, o custo por análise é de centavos.

---

## Trocar de provedor de IA

Para usar Claude em vez de Gemini, altere apenas o arquivo `api/analisar.js`:
o endpoint, o cabeçalho de autenticação e o caminho de leitura da resposta.
O app do celular não muda nada — ele só conversa com o seu backend.
Versão corrigida.
