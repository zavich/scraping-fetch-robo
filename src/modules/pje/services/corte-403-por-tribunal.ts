import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

// Quantos 403 seguidos (sem nenhum sucesso no meio) o tribunal precisa
// devolver para entrar em corte, e por quanto tempo o corte vale.
export const LIMIAR_403_SEGUIDOS = 5;
export const DURACAO_CORTE_S = 15 * 60;
// A sequência esquece sozinha depois disso, para um 403 isolado de horas atrás
// não somar com o de agora.
const JANELA_SEQUENCIA_S = 10 * 60;

const chaveSequencia = (host: string) => `seq403:${host}`;
const chaveCorte = (host: string) => `corte403:${host}`;

/**
 * Corte automático das novas tentativas de 403 por tribunal (host do PJe).
 *
 * Alguns tribunais bloqueiam o IP de saída do scraping no WAF e respondem 403
 * a toda consulta; as novas tentativas (3+6+12+24s por instância) nunca
 * passam. Medido em 21–22/10/2026: TRT1 e TRT12 com 0 de 76 403 recuperados, ~90 s
 * perdidos por processo e uma busca de 173 CNJs presa 9 min esperando por eles.
 *
 * Com LIMIAR_403_SEGUIDOS 403 seguidos, o tribunal entra em corte: a primeira
 * consulta de cada processo continua sendo feita, mas um 403 não é mais
 * repetido. Qualquer resposta de sucesso zera a sequência e desfaz o corte —
 * o tribunal se testa sozinho e volta ao normal assim que liberar.
 *
 * Estado no Redis para valer entre as tasks e os workers. Falha do Redis
 * nunca derruba a consulta: sem estado, o comportamento é o de sempre.
 */
export class Corte403PorTribunal {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  static host(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  async emCorte(host: string): Promise<boolean> {
    if (!host) return false;
    try {
      return (await this.redis.exists(chaveCorte(host))) === 1;
    } catch {
      return false;
    }
  }

  async registrar403(host: string): Promise<void> {
    if (!host) return;
    try {
      const seguidos = await this.redis.incr(chaveSequencia(host));
      if (seguidos === 1) {
        await this.redis.expire(chaveSequencia(host), JANELA_SEQUENCIA_S);
      }
      if (seguidos < LIMIAR_403_SEGUIDOS) return;
      const entrou = await this.redis.set(
        chaveCorte(host),
        new Date().toISOString(),
        'EX',
        DURACAO_CORTE_S,
        'NX',
      );
      if (entrou === 'OK') {
        this.logger.warn(
          `✂️ ${host} devolveu ${seguidos} 403 seguidos — sem novas tentativas de 403 por ${DURACAO_CORTE_S / 60} min (a 1ª consulta de cada processo continua)`,
        );
      }
    } catch {
      // sem estado: segue com as tentativas de sempre
    }
  }

  async registrarSucesso(host: string): Promise<void> {
    if (!host) return;
    try {
      const [, cortado] = await Promise.all([
        this.redis.del(chaveSequencia(host)),
        this.redis.del(chaveCorte(host)),
      ]);
      if (cortado === 1) {
        this.logger.log(
          `✅ ${host} voltou a responder — corte de 403 desfeito`,
        );
      }
    } catch {
      // sem estado: nada a desfazer
    }
  }
}
