import { ItensProcesso, Partes, Polo, ProcessosResponse } from 'src/interfaces';
import { Root } from 'src/interfaces/normalize';

type Assunto = {
  principal: boolean;
  descricao: string;
};

export function normalizeResponse(
  numero: string,
  body: ProcessosResponse[],
  message = 'processo não encontrado',
  isDocument = false,
  origem?: string,
): Root {
  const opcoes: { [key: string]: any } = {
    documento: false,
  };
  function generateId(length = 11) {
    const chars = '0123456789';
    let resposta = '';
    for (let i = 0; i < length; i++) {
      resposta += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return Number(resposta);
  }
  if (origem) {
    opcoes['origem'] = origem;
  }
  if (isDocument) {
    opcoes['documento'] = true;
  }
  const now = new Date();
  if (!body || body.length === 0) {
    return {
      id: generateId(),
      created_at: {
        date: now.toISOString()?.replace('T', ' ').substring(0, 19),
        timezone_type: 3,
        timezone: 'UTC',
      },
      numero_processo: numero,
      resposta: { message },
      status: 'NAO_ENCONTRADO',
      motivo_erro: 'SEM_DADOS',
      status_callback: null,
      tipo: 'BUSCA_PROCESSO',
      opcoes,
      tribunal: {
        sigla: origem ? 'TST' : 'TRT',
        nome: 'Tribunal Regional do Trabalho',
        busca_processo: 1,
      },
    };
  }

  const regionTRT = Number(body[0]?.numero.split('.')[3]);
  const isTrabalhista = Number(body[0]?.numero.split('.')[2]);

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

    ['poloAtivo', 'poloPassivo'].forEach((poloKey) => {
      ((instance[poloKey] as Polo[]) ?? []).forEach((parte: Polo) => {
        // Parte principal
        partes.push({
          id: parte.id,
          tipo: parte.tipo,
          nome: parte.nome.trim(),
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
            nome: rep.nome.trim(),
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
            //   .map((_: any) => ({
            //     numero: '', // substituir pelo número real da OAB
            //     uf: rep.endereco?.estado ?? '', // garantir que seja sempre string
            //   })),
          });
        });
      });
    });

    partes = atualizarNomesPartes(instance.itensProcesso, partes);

    const movimentacoes = instance?.itensProcesso?.map((item) => {
      const partesConteudo = [
        item?.titulo,
        item?.tipo ? `| ${item.tipo}` : '',
        !item?.publico && item?.documento ? '(Restrito)' : '',
      ]
        .filter(Boolean)
        .join(' ');

      return {
        data: new Intl.DateTimeFormat('pt-BR').format(new Date(item.data)),
        conteudo: partesConteudo,
        id: generateId(),
      };
    });

    const resposta = {
      id: instance.id,
      assunto: instance.assuntos.find((item: Assunto) => item.principal)
        ?.descricao,
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

    if (isDocument) {
      resposta['documentos_restritos'] = instance.documentos_restritos;
      resposta['documentos'] = instance.documentos;
    }

    return resposta;
  });
  const instanciasComNomesCompletos = mergePartesCompletas(instancias);
  if (origem) {
    opcoes['origem'] = origem;
  }
  if (isDocument) {
    opcoes['autos'] = true;
  }
  const resposta =
    body.length > 0
      ? {
          numero_unico: body[0]?.numero,
          origem: origem ? 'TST' : `TRT-${regionTRT}`,
          instancias: instanciasComNomesCompletos,
          id: generateId(),
        }
      : {
          message,
          id: generateId(),
        };
  return {
    id: generateId(),
    created_at: {
      date: now.toISOString()?.replace('T', ' ').substring(0, 19),
      timezone_type: 3,
      timezone: 'UTC',
    },
    numero_processo: body[0]?.numero,
    resposta,
    status: body.length > 0 ? 'SUCESSO' : 'NAO_ENCONTRADO',
    motivo_erro: null,
    status_callback: null,
    tipo: 'BUSCA_PROCESSO',
    opcoes,
    tribunal: {
      sigla: origem ? 'TST' : `TRT`,
      nome: 'Tribunal Regional do Trabalho',
      busca_processo: 1,
    },
    valor: body[0]?.numero,
  } as Root;
}

function mergePartesCompletas(instancias: any[]) {
  const mapaPartes = new Map<string, any>();

  for (const inst of instancias) {
    for (const parte of inst.partes || []) {
      if (!parte || !parte.nome) continue;

      const chave =
        parte.documento?.numero ||
        parte.id ||
        parte.nome
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toUpperCase();

      const existente = mapaPartes.get(chave);

      if (!existente) {
        // Adiciona novo
        mapaPartes.set(chave, { ...parte });
        continue;
      }

      // Atualiza nome mais completo
      const nomeNovoLimpo = parte.nome.replace(/[.\s]/g, '').trim();
      const nomeAntigoLimpo = existente.nome.replace(/[.\s]/g, '').trim();
      const nomeMaisCompleto =
        nomeNovoLimpo.length > nomeAntigoLimpo.length
          ? parte.nome
          : existente.nome;

      if (nomeMaisCompleto !== existente.nome) {
        console.log(
          `🟢 Atualizando parte duplicada: "${existente.nome}" → "${nomeMaisCompleto}"`,
        );
      }

      const tipoFinal =
        existente.tipo === 'RECLAMANTE' ||
        existente.tipo === 'RECLAMADO' ||
        existente.tipo === 'AUTOR' ||
        existente.tipo === 'RÉU'
          ? existente.tipo
          : parte.tipo || existente.tipo;

      const poloFinal = existente.principal
        ? existente.polo
        : parte.polo || existente.polo;

      const advogadoDe = existente.advogado_de || parte.advogado_de;

      mapaPartes.set(chave, {
        ...existente,
        nome: nomeMaisCompleto,
        tipo: tipoFinal,
        polo: poloFinal,
        advogado_de: advogadoDe,
      });
    }
  }

  // Substitui nas instâncias e adiciona novas partes que não existiam
  const partesConsolidadas = Array.from(mapaPartes.values());

  return instancias.map((inst) => ({
    ...inst,
    partes: partesConsolidadas.filter((parte) => {
      // Mantém só partes que pertencem à instância ou são novas (não duplicadas)
      return (
        inst.partes?.some((p) => {
          const chaveP =
            p.documento?.numero ||
            p.id ||
            p.nome
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toUpperCase();
          return (
            chaveP ===
            (parte.documento?.numero ||
              parte.id ||
              parte.nome
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toUpperCase())
          );
        }) || !parte.id
      );
    }),
  }));
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
  const regexNomeCompleto =
    /([A-Z][A-Z0-9&\.\(\)\/-]*(?:\s+[A-Z0-9&\.\(\)\/-]+)+)/g;

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

  titulos.forEach(({ titulo }) => {
    // normaliza o título antes de aplicar o regex
    const normalized = normalizeTitleForRegex(titulo);
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
          .replace(/[.,()\/-]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        return [key, n];
      }),
    ).values(),
  );

  return partes.map((parte) => {
    if (parte.tipo === 'ADVOGADO') return parte;

    const sigParte = gerarSiglas(parte.nome);
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
        melhorNome = nomeTitulo;
        break;
      }
    }

    return { ...parte, nome: melhorNome };
  });
}

function matchSiglas(sigParte: string, sigTitulo: string): boolean {
  const a = sigParte.replace(/[^A-Z0-9]/g, '');
  const b = sigTitulo.replace(/[^A-Z0-9]/g, '');

  // Match exato → sucesso imediato
  if (a === b) return true;

  // Prefixo igual → ex: PBTVS começa com PBTV
  if (b.startsWith(a) || a.startsWith(b)) return true;

  // Tolerância mínima: todas as letras de a aparecem em ordem em b
  let i = 0;
  for (const c of b) {
    if (c === a[i]) i++;
    if (i === a.length) return true;
  }

  return false;
}
