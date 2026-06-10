import { ItensProcesso, Partes, Polo, ProcessosResponse } from 'src/interfaces';
import { Root } from 'src/interfaces/normalize';
import { randomUUID } from 'crypto';

type NormalizeResponseOptions = {
  documento?: boolean;
  autos?: boolean;
  origem?: string;
  webhookId?: string;
  status?: 'SUCESSO' | 'NAO_ENCONTRADO' | 'ERRO';
  motivoErro?: string | null;
  tribunalSigla?: string;
};

export function normalizeResponse(
  numero: string,
  body: ProcessosResponse[],
  message = 'processo não encontrado',
  options: NormalizeResponseOptions = {},
): Root {
  const opcoes: Record<string, unknown> = options.autos
    ? { autos: true }
    : { documento: options.documento ?? false };
  function generateId(length = 11) {
    const chars = '0123456789';
    let resposta = '';
    for (let i = 0; i < length; i++) {
      resposta += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return Number(resposta);
  }
  if (options.origem) {
    opcoes['origem'] = options.origem;
  }
  const now = new Date();
  if (!body || body.length === 0) {
    return {
      id: generateId(),
      webhookId: options.webhookId ?? randomUUID(),
      created_at: {
        date: now.toISOString()?.replace('T', ' ').substring(0, 19),
        timezone_type: 3,
        timezone: 'UTC',
      },
      numero_processo: numero,
      resposta: { message },
      status: options.status ?? 'NAO_ENCONTRADO',
      motivo_erro: options.motivoErro ?? 'SEM_DADOS',
      status_callback: null,
      tipo: 'BUSCA_PROCESSO',
      opcoes,
      tribunal: {
        sigla: options.tribunalSigla ?? (options.origem ? 'TST' : 'TRT'),
        nome: 'Tribunal Regional do Trabalho',
        busca_processo: 1,
      },
    };
  }
  const match = numero.match(/^\d{7}-\d{2}\.\d{4}\.\d\.(\d{2})\.\d{4}$/);

  const regionTRT = match ? Number(match[1]) : null;

  const isTrabalhista = Number(numero.split('.')[2]);

  // Pre-computa Map<documento, bestName> em um unico O(body) pass.
  // Antes era O(partes x body) — quadratico em processos com muitas partes/movs.
  const bestNameByDocument = new Map<string, string>();
  for (const instance of body) {
    for (const poloKey of ['poloAtivo', 'poloPassivo'] as const) {
      const polos = instance[poloKey] ?? [];
      for (const polo of polos) {
        const poloDoc = String(polo?.login ?? '').replace(/\D/g, '');
        if (poloDoc) {
          const candidate = String(polo?.nome ?? '').trim();
          const current = bestNameByDocument.get(poloDoc) ?? '';
          if (!current || isBetterNameCandidate(current, candidate)) {
            bestNameByDocument.set(poloDoc, candidate);
          }
        }

        for (const rep of polo.representantes || []) {
          const repDoc = String(rep?.login ?? '').replace(/\D/g, '');
          if (!repDoc) continue;
          const candidate = String(rep?.nome ?? '').trim();
          const current = bestNameByDocument.get(repDoc) ?? '';
          if (!current || isBetterNameCandidate(current, candidate)) {
            bestNameByDocument.set(repDoc, candidate);
          }
        }
      }
    }
  }

  function getBestNameByDocument(baseName: string, login?: string): string {
    const baseTrim = String(baseName ?? '').trim();
    const documentNumber = String(login ?? '').replace(/\D/g, '');
    if (!documentNumber) return baseTrim;

    const fromMap = bestNameByDocument.get(documentNumber);
    if (!fromMap) return baseTrim;
    return isBetterNameCandidate(baseTrim, fromMap) ? fromMap : baseTrim;
  }

  const instancias = body.map((instance, index) => {
    const grauInstanciaMap = ['PRIMEIRO_GRAU', 'SEGUNDO_GRAU'];
    const arquivado = instance?.itensProcesso?.some((item) =>
      item.titulo.match(
        /\bArquivados\s+os\s+autos\s+definitivamente\b[.!]?\s*$/i,
      ),
    );
    const data_arquivamento = arquivado
      ? instance.itensProcesso.find((item) =>
          item.titulo.match(
            /\bArquivados\s+os\s+autos\s+definitivamente\b[.!]?\s*$/i,
          ),
        )?.data
      : null;
    let partes: Partes[] = [];
    if (index === 0) {
      ['poloAtivo', 'poloPassivo'].forEach((poloKey) => {
        ((instance[poloKey] as Polo[]) ?? []).forEach((parte: Polo) => {
          // Parte principal
          partes.push({
            id: parte.id,
            tipo: parte.tipo,
            nome: getBestNameByDocument(parte.nome, parte.login),
            principal: true,
            polo: parte.polo,
            documento: {
              tipo:
                parte?.login?.replace(/\D/g, '').length === 11 ? 'CPF' : 'CNPJ',
              numero: parte?.login?.replace(/\D/g, ''),
            },
          });

          // Representantes
          (parte.representantes || []).forEach((rep: Polo) => {
            partes.push({
              id: rep.id,
              tipo: rep.tipo,
              nome: getBestNameByDocument(rep.nome, rep.login),
              principal: false,
              polo: rep.polo,
              documento: {
                tipo:
                  rep.login?.replace(/\D/g, '').length === 11 ? 'CPF' : 'CNPJ',
                numero: rep.login?.replace(/\D/g, ''),
              },
              advogado_de: parte.id,
              // oabs: (rep.papeis || [])
              //   .filter((p: Papeis) => p.identificador === 'advogado')
              //   .map((_: unknown) => ({
              //     numero: '', // substituir pelo número real da OAB
              //     uf: rep.endereco?.estado ?? '', // garantir que seja sempre string
              //   })),
            });
          });
        });
      });

      partes = atualizarNomesPartes(instance.itensProcesso, partes);
    }

    const movimentacoes = instance?.itensProcesso?.map((item) => {
      const partesConteudo = [
        item?.titulo,
        item?.tipo ? `| ${item.tipo}` : '',
        !item?.publico && item?.documento ? '(Restrito)' : '',
      ]
        .filter(Boolean)
        .join(' ');

      const mov: {
        data: string;
        conteudo: string;
        id: number;
        uniqueNameDocumento?: string;
      } = {
        data: new Intl.DateTimeFormat('pt-BR').format(new Date(item.data)),
        conteudo: partesConteudo,
        id: generateId(),
      };

      // adiciona uniqueNameDocumento apenas se existir e não for string vazia
      if (item?.idUnicoDocumento != null && item.idUnicoDocumento !== '') {
        mov.uniqueNameDocumento = String(item.idUnicoDocumento);
      }

      return mov;
    });

    const resposta = {
      id: instance.id,
      assunto: instance.assuntos,
      sistema: 'PJE',
      instancia: grauInstanciaMap[index],
      segredo: instance.segredoJustica,
      numero: null,
      classe: instance.classe,
      area: isTrabalhista ? 'Trabalhista' : 'Não Trabalhista',
      data_distribuicao: instance.distribuidoEm,
      orgao_julgador: instance.orgaoJulgador,
      pessoa_relator: instance.pessoaRelator,
      moeda_valor_causa: 'R$',
      valor_causa: instance.valorDaCausa,
      arquivado,
      data_arquivamento: data_arquivamento || null,
      fisico: null,
      last_update_time: now.toISOString()?.replace('T', ' ').substring(0, 19),
      situacoes: [],
      partes,
      movimentacoes,
    };

    if (options.autos) {
      resposta['documentos_restritos'] = instance.documentos_restritos;
      resposta['documentos'] = instance.documentos;
    }

    return resposta;
  });
  const resposta =
    body.length > 0
      ? {
          numero_unico: body[0]?.numero,
          origem: options.origem ? 'TST' : `TRT-${regionTRT}`,
          instancias,
          id: generateId(),
        }
      : {
          message,
          id: generateId(),
        };
  return {
    id: generateId(),
    webhookId: options.webhookId ?? randomUUID(),
    created_at: {
      date: now.toISOString()?.replace('T', ' ').substring(0, 19),
      timezone_type: 3,
      timezone: 'UTC',
    },
    numero_processo: body[0]?.numero,
    resposta,
    status: options.status ?? (body.length > 0 ? 'SUCESSO' : 'NAO_ENCONTRADO'),
    motivo_erro: options.motivoErro ?? null,
    status_callback: null,
    tipo: 'BUSCA_PROCESSO',
    opcoes,
    tribunal: {
      sigla: options.tribunalSigla ?? (options.origem ? 'TST' : `TRT`),
      nome: 'Tribunal Regional do Trabalho',
      busca_processo: 1,
    },
    valor: body[0]?.numero,
  } as Root;
}

function gerarSiglas(nome: string): string {
  const stopwords = new Set([
    'DE',
    'DA',
    'DO',
    'DAS',
    'DOS',
    'E',
    'EM',
    'NO',
    'NA',
    'NOS',
    'NAS',
    'A',
    'O',
    'AS',
    'OS',
    'POR',
    'COM',
    'LTDA',
    'S/A',
    'ME',
    'EPP',
    'EIRELI',
    'SA',
  ]);

  return (
    nome
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // remove acentos
      .replace(/[(),.]/g, ' ') // remove pontuação irrelevante
      .replace(/-/g, ' ') // trata hífen como separador
      // 🔹 protege sufixos empresariais antes do split
      .replace(/\bS\/A\b/gi, '') // remove S/A
      .replace(/\bLTDA\b/gi, '')
      .replace(/\bEIRELI\b/gi, '')
      .replace(/\bME\b/gi, '')
      .replace(/\bEPP\b/gi, '')
      .split(/\s+/)
      .filter(Boolean)
      .filter((word) => !stopwords.has(word.toUpperCase()))
      .map((word) => word[0].toUpperCase())
      .join('. ')
      .concat('.')
  );
}

export function atualizarNomesPartes(
  titulos: ItensProcesso[],
  partes: Partes[],
): Partes[] {
  // aceita agora / e - dentro das palavras (mas vamos normalizar antes)
  const regexNomeCompleto = /([A-Z][A-Z0-9&.()/-]*(?:\s+[A-Z0-9&.()/-]+)+)/g;

  // 🔹 Função que normaliza o título para facilitar a extração
  function normalizeTitleForRegex(t: string): string {
    return (
      String(t)
        // Normaliza espaços, trata - e / como separadores e remove duplicações estranhas
        .replace(/\u00A0/g, ' ') // non-breaking space -> normal space
        .replace(/\s*[-/]\s*/g, ' ') // transforma '-' e '/' (com espaços) em espaço único
        .replace(/[.,]/g, ' ') // opcional: trata pontos e vírgulas como separadores
        .replace(/\s+/g, ' ') // colapsa múltiplos espaços
        .trim()
    );
  }

  const nomesExtraidos: { nome: string; siglas: string }[] = [];

  function extractNameHintsFromTitle(normalizedTitle: string): string[] {
    const hints: string[] = [];

    // Ex.: "Decorrido o prazo de SINDICATO ... - SINTERGIA/RJ em 17/03/2025"
    const deNomeEmDataRegex =
      /\bde\s+([A-ZÀ-Ý0-9&.()/-]+(?:\s+[A-ZÀ-Ý0-9&.()/-]+)+?)\s+em\s+\d{2}\/\d{2}\/\d{4}\b/gi;

    let match: RegExpExecArray | null;
    while ((match = deNomeEmDataRegex.exec(normalizedTitle)) !== null) {
      const hint = String(match[1]).trim();
      if (hint.split(/\s+/).length >= 2) {
        hints.push(hint);
      }
    }

    return hints;
  }

  titulos.forEach(({ titulo }) => {
    // normaliza o título antes de aplicar o regex
    const normalized = normalizeTitleForRegex(titulo);

    // Primeiro tenta extrair nomes em padrões textuais comuns de movimentação.
    extractNameHintsFromTitle(normalized).forEach((hint) => {
      nomesExtraidos.push({ nome: hint, siglas: gerarSiglas(hint) });
    });

    let match: RegExpExecArray | null;
    // executa o regex na versão normalizada
    while ((match = regexNomeCompleto.exec(normalized)) !== null) {
      const nome = String(match[1]).trim();
      // filtra nomes curtos (pelo menos 2 palavras)
      if (nome.split(/\s+/).length >= 2) {
        nomesExtraidos.push({ nome, siglas: gerarSiglas(nome) });
      }
    }
  });

  // 🔹 Remover duplicatas usando o nome normalizado como chave (evita pequenas variações)
  const nomesUnicos = Array.from(
    new Map(
      nomesExtraidos.map((n) => {
        // chave: nome sem pontuação extra e com espaços normalizados
        const key = n.nome
          .replace(/[.,()/-]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        return [key, n];
      }),
    ).values(),
  );

  return partes.map((parte) => {
    if (parte.tipo === 'ADVOGADO') return parte;

    const sigParte = isInitialsLikeName(parte.nome)
      ? initialsFingerprint(parte.nome)
      : gerarSiglas(parte.nome);
    let melhorNome = parte.nome;

    for (const { nome: nomeTitulo, siglas: sigTituloRaw } of nomesUnicos) {
      const sigTitulo = sigTituloRaw.replace(/[^A-Z0-9]/g, '')?.trim();
      const sigParteClean = sigParte.replace(/[^A-Z0-9]/g, '')?.trim();

      // Número do documento bate → assume direto
      if (
        parte.documento?.numero &&
        nomeTitulo.includes(parte.documento.numero)
      ) {
        melhorNome = nomeTitulo;
        break;
      }

      // Comparador simples e robusto
      if (matchSiglas(sigParteClean, sigTitulo)) {
        if (isBetterNameCandidate(melhorNome, nomeTitulo)) {
          melhorNome = nomeTitulo;
        }
        // Continua procurando para privilegiar nome por extenso quando existir.
        continue;
      }
    }

    return { ...parte, nome: melhorNome };
  });
}

function initialsFingerprint(name: string): string {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[(),.]/g, ' ')
    .replace(/[/-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token[0].toUpperCase())
    .join('');
}

function isBetterNameCandidate(
  currentName: string,
  candidateName: string,
): boolean {
  const current = String(currentName || '').trim();
  const candidate = String(candidateName || '').trim();

  if (!candidate) return false;
  if (!current) return true;
  if (candidate === current) return false;

  const currentInitials = isInitialsLikeName(current);
  const candidateInitials = isInitialsLikeName(candidate);

  // Nunca troca nome por extenso por nome em sigla.
  if (!currentInitials && candidateInitials) return false;

  const currentInfo = countInformativeWords(current);
  const candidateInfo = countInformativeWords(candidate);

  if (candidateInfo > currentInfo) return true;
  if (candidateInfo < currentInfo) return false;

  // Empate: favorece o nome mais longo quando ambos têm mesmo nível de informação.
  return candidate.length > current.length;
}

function isInitialsLikeName(name: string): boolean {
  const tokens = String(name)
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-zÀ-ÿ0-9]/g, ''))
    .filter(Boolean);

  if (tokens.length === 0) return false;

  const shortTokens = tokens.filter((token) => token.length <= 2).length;
  return shortTokens / tokens.length >= 0.6;
}

function countInformativeWords(name: string): number {
  return String(name)
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-zÀ-ÿ0-9]/g, ''))
    .filter((token) => token.length >= 3).length;
}

function matchSiglas(sigParte: string, sigTitulo: string): boolean {
  const a = sigParte.replace(/[^A-Z0-9]/g, '');
  const b = sigTitulo.replace(/[^A-Z0-9]/g, '');

  // Match exato → sucesso imediato
  if (a === b) return true;

  // Prefixo igual → ex: PBTVS começa com PBTV
  if (b.startsWith(a) || a.startsWith(b)) return true;

  // Tolerância: subsequência nos dois sentidos.
  // Isso cobre casos como iniciais extras de stopwords (ex.: "NAS") no nome truncado.
  if (isSubsequence(a, b) || isSubsequence(b, a)) return true;

  return false;
}

function isSubsequence(target: string, source: string): boolean {
  if (!target) return false;

  let index = 0;
  for (const char of source) {
    if (char === target[index]) index++;
    if (index === target.length) return true;
  }

  return false;
}
