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
          instancias,
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
  ]);

  return nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[.,]/g, ' ') // trata pontos e vírgulas como separadores
    .replace(/[()]/g, '') // remove parênteses
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => {
      // 🔹 mantém se for inicial tipo "E." mesmo sendo stopword
      if (/^[A-Z]\.?$/i.test(word)) return true;
      // 🔹 ignora stopwords para palavras normais
      return !stopwords.has(word.toUpperCase());
    })
    .map((word) => {
      // se for sigla tipo "S." → pega a letra
      if (/^[A-Z]\.?$/.test(word)) return word[0];
      // se for palavra tipo "SANTANDER" → primeira letra
      return word[0];
    })
    .join('')
    .toUpperCase();
}

export function atualizarNomesPartes(
  titulos: ItensProcesso[],
  partes: Partes[],
): Partes[] {
  const regexNomeCompleto =
    /([A-Z][A-Z0-9&\.\(\)-]*(?:\s+[A-Z0-9&\.\(\)-]+)+)/g;

  // 🔹 Função para gerar siglas corretamente

  // 🔹 Extrair nomes completos dos títulos com siglas
  const nomesExtraidos: { nome: string; siglas: string }[] = [];

  titulos.forEach(({ titulo }) => {
    let match: RegExpExecArray | null;
    while ((match = regexNomeCompleto.exec(titulo)) !== null) {
      const nome = String(match[1]).trim();
      if (nome.split(/\s+/).length >= 2) {
        nomesExtraidos.push({ nome, siglas: gerarSiglas(nome) });
      }
    }
  });

  // 🔹 Remover duplicatas
  const nomesUnicos = Array.from(
    new Map(nomesExtraidos.map((n) => [n.nome, n])).values(),
  );

  return partes.map((parte) => {
    // ⚠️ Não altera nomes de advogados
    if (parte.tipo === 'ADVOGADO') return parte;

    const sigParte = gerarSiglas(parte.nome);
    let melhorNome = parte.nome;
    for (const { nome: nomeTitulo, siglas: sigTituloRaw } of nomesUnicos) {
      // Empresa só se CNPJ
      const sigTitulo = sigTituloRaw.replace(/[^A-Z0-9]/g, '')?.trim();
      const sigParteClean = sigParte.replace(/[^A-Z0-9]/g, '')?.trim();
      // if (
      //   parte.documento?.tipo === 'CNPJ' &&
      //   !/[A-Z]{1,}\s*(?:S\/A|LTDA|ME|EIRELI)/i.test(nomeTitulo)
      // ) {
      //   continue;
      // }

      // Número do documento bate → assume direto
      if (
        parte.documento?.numero &&
        nomeTitulo.includes(parte.documento.numero)
      ) {
        melhorNome = nomeTitulo;
        break;
      }

      // Correspondência mínima de siglas → pega primeiro match
      // Correspondência mínima de siglas → pega primeiro match aproximado
      if (matchSiglas(sigParteClean, sigTitulo)) {
        melhorNome = nomeTitulo;
        break;
      }
    }

    return { ...parte, nome: melhorNome };
  });
}
function matchSiglas(sigParte: string, sigTitulo: string): boolean {
  sigParte = sigParte.replace(/[^A-Z0-9]/g, '').slice(0, 4); // 🔹 apenas 4 primeiras letras
  sigTitulo = sigTitulo.replace(/[^A-Z0-9]/g, '');

  let i = 0;
  for (const c of sigTitulo) {
    if (c === sigParte[i]) i++;
    if (i === sigParte.length) return true;
  }
  return false;
}
