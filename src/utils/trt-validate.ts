// TRTs cujo login (`/pje-consulta-api/api/auth`) não funciona: o login é feito
// no TRT2 e o token dele é usado nas chamadas ao TRT de destino.
//
// Em 21/10/2026 o endpoint respondia 404 ("API solicitada não existe",
// ARQ-013) em 4, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 19, 21, 22 e 24 — o
// login de documentos restritos falhava em todas as contas e a coleta voltava
// como PJE_FORA_DO_AR. Testado no TRT4 (0021065-12.2024.5.04.0022): com o token
// do TRT2 a visão autenticada traz 40 documentos restritos, contra 0 sem login.
// O TRT3 entra pela mesma razão (o endpoint de auth foi removido), embora o
// teste direto devolva 405 do anti-bot antes de chegar na rota.
// 12, 20 e 23 ficaram de fora: a resposta foi inconclusiva (WAF, 500, 200),
// não "rota inexistente".
export const LoginErrorTrt = [
  1, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24,
];
