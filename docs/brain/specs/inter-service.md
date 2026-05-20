# Inter-Service Communication

## Webhooks enviados (scraping → robo-api)

### Webhook de processo

- **URL**: `job.data.webhook ?? process.env.WEBHOOK_URL + '/process/webhook'`
- **Metodo**: POST
- **Auth**: nenhuma
- **Trigger**: apos cada job de processo (sucesso ou falha)

**Payload sucesso** (interface `Root`):
```typescript
{
  id: number,                    // aleatorio 11 digitos
  created_at: {
    date: "YYYY-MM-DD HH:MM:SS",
    timezone_type: 3,
    timezone: "UTC"
  },
  numero_processo: string,
  resposta: {
    numero_unico: string,        // numero do processo da primeira instancia
    origem: "TST" | "TRT-{N}",
    instancias: Instancia[],
    id: number                   // aleatorio 11 digitos
  },
  status: "SUCESSO",
  motivo_erro: null,
  status_callback: null,
  tipo: "BUSCA_PROCESSO",
  opcoes: {
    documento: boolean,
    origem?: "TST",
    autos?: true
  },
  tribunal: {
    sigla: "TST" | "TRT",
    nome: "Tribunal Regional do Trabalho",
    busca_processo: 1
  },
  valor: string                  // = numero_processo
}
```

**Payload erro/nao encontrado**:
```typescript
{
  id: number,
  created_at: { date, timezone_type: 3, timezone: "UTC" },
  numero_processo: string,
  resposta: { message: "Nenhum resultado encontrado" },
  status: "NAO_ENCONTRADO",
  motivo_erro: "SEM_DADOS",
  status_callback: null,
  tipo: "BUSCA_PROCESSO",
  opcoes: { documento: false, origem?: "TST" },
  tribunal: { sigla: "TST"|"TRT", nome: "Tribunal...", busca_processo: 1 }
}
```

### Webhook CNDT

- **URL**: `process.env.WEBHOOK_URL + '/company/webhook?type=cndt'`
- **Metodo**: POST
- **Auth**: `Authorization: {process.env.AUTHORIZATION_ESCAVADOR}` (sem prefixo "Bearer")
- **Payload**:
  ```typescript
  {
    cnpj: string,
    temp_link: string    // chave S3 (nao URL completa), formato: "{cnpj}_cndt_{timestamp}.pdf"
  }
  ```

---

## APIs externas chamadas

### PJE API

Base URL: `https://pje.trt{N}.jus.br` (ou `pje.tst.jus.br` para TST)

| Metodo | Endpoint | Uso |
|--------|----------|-----|
| GET | `/primeirograu/login.seam` | Verificacao de disponibilidade (timeout 10s, HTTP >= 500 = ServiceUnavailableException) |
| POST | `/pje-consulta-api/api/auth` | Login (body: `{ login, senha }`) |
| GET | `/pje-consulta-api/api/processos/dadosbasicos/{numero}` | Dados basicos do processo |
| GET | `/pje-consulta-api/api/processos/{id}[?tokenCaptcha=...][?tokenDesafio=...&resposta=...]` | Dados completos do processo |
| GET | `/pje-consulta-api/api/processos/{id}/integra?tokenCaptcha={token}` | PDF integra (arraybuffer) |

**Headers enviados no login**:
```typescript
{
  'x-grau-instancia': '1',
  'accept': 'application/json, text/plain, */*',
  'user-agent': randomUserAgent(),      // pool de user agents (HTTP)
  'content-type': 'application/json',
  'referer': 'https://pje.trt{N}.jus.br/consultaprocessual/login',
  'Cookie': '{aws-waf-token do Redis}' || ''
}
```

**TRT remapping (LoginErrorTrt)**:
- TRT18 e TRT5 roteiam auth para TRT2: `regionTRTValidate = [18, 5].includes(regionTRT) ? 2 : regionTRT`
- Isso significa que TRT18 e TRT5 compartilham sessao com TRT2

### 2Captcha API

| Metodo | Endpoint | Uso |
|--------|----------|-----|
| GET | `https://2captcha.com/res.php?action=getbalance` | Verificar saldo (chamado ANTES de cada fetch de processo) |
| POST | `https://2captcha.com/in.php` | Submeter captcha de imagem |
| GET | `https://2captcha.com/res.php?action=get&id={id}` | Obter resultado captcha imagem |
| POST | `https://api.2captcha.com/createTask` | Criar task AWS WAF (`AmazonTaskProxyless`) |
| POST | `https://api.2captcha.com/getTaskResult` | Poll resultado WAF (cada 5s, ate 40 tentativas = 200s max) |

**Nota**: dominio `2captcha.com` para captcha de imagem, `api.2captcha.com` para AWS WAF tasks.

**Abort path**: se `getBalance() < 0.001`, o job inteiro aborta imediatamente.

### AWS WAF Voucher

- **URL**: `POST {voucherBaseUrl}/voucher`
- **Executado via**: `page.evaluate()` dentro do contexto do browser
- **Proposito**: trocar tokens captcha por cookie WAF

### Receita Federal

| URL | Uso |
|-----|-----|
| `https://solucoes.receita.fazenda.gov.br/servicos/cnpjreva/cnpjreva_solicitacao.asp` | Formulario CNPJ |
| `POST https://solucoes.receita.fazenda.gov.br/servicos/cnpjreva/valida_recaptcha.asp` | Validacao hCaptcha |
| `https://solucoes.receita.fazenda.gov.br/servicos/cnpjreva/Cnpjreva_Comprovante.asp` | Pagina de resultado |
| `https://cndt-certidao.tst.jus.br/gerarCertidao.faces` | Pagina CNDT |

---

## Login Pool (detalhes)

### Pool de contas

6 contas em array fixo: FIRST, SECOND, THIRD, FOURTH, FIFTH, SIXTH.
Carregadas de env vars no momento de instanciacao da classe (nao injetadas).

### Logica de rotacao

```
contaIndex = 0, contadorProcessos = 0

getConta(force = false):
  if (force OR contadorProcessos >= 5):
    contaIndex = (contaIndex + 1) % 6
    contadorProcessos = 0
  contadorProcessos++
  return contas[contaIndex]
```

- `force=true`: rotacao imediata para proxima conta (usado apos falha de login)
- Cada 5 chamadas sem `force` rotaciona para proxima conta
- Contador incrementa mesmo quando cookie vem do cache Redis

### Fluxo getCookies(trt)

```
1. GET pje:session:{trt} do Redis
2. Se cookie existe:
   a. GET TTL da chave
   b. Se TTL == -2 (chave expirou): chama renovarSessao()
   c. Valida cookie contem 'access_token' e 'refresh_token'
   d. Se invalido: DEL ambas chaves, chamada recursiva getCookies()
   e. Se valido: return { cookies, account: getConta() }
3. Se sem cookie: checkSiteAvailability(trt) [GET primeirograu/login.seam, timeout 10s]
4. SETNX pje:lock:{trt} com PX 15000
5. Se lock adquirido:
   a. Tenta todas 6 contas em ordem
   b. Para cada: loginService.execute() -> POST /api/auth
   c. Sucesso: SET pje:session:{trt} EX 3600, SET pje:session:{trt}:ready EX 30
   d. Falha: incrementa tentativas, tenta proxima conta com force=true
   e. DEL lockKey em sucesso ou erro
6. Se lock nao adquirido (outro worker tem):
   a. Poll readyKey cada 500ms por ate 60000ms
   b. Quando ready: GET cookie do Redis
7. Se ainda sem cookie apos 60s: forca novo login com getConta(true)
8. Return { cookies, account }
```

### Login HTTP-only

Login atual e 100% HTTP (POST para `/pje-consulta-api/api/auth`). Codigo de login via Puppeteer esta **todo comentado**. Delay de 1s hardcoded no inicio de cada login.

### Delay login

`setTimeout(1000)` no inicio de cada chamada `loginService.execute()`.
