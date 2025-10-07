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
    if (!isDocument) {
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
function scoreIniciais(partesIni: string, tituloIni: string): number {
  if (!partesIni || !tituloIni) return 0;
  let score = 0;
  const tituloArr = tituloIni?.split('');
  partesIni?.split('').forEach((l) => {
    if (tituloArr?.includes(l)) score++;
  });
  return score / partesIni.length; // retorna % de correspondência
}

export function atualizarNomesPartes(
  titulos: ItensProcesso[],
  partes: Partes[],
  limiar = 0.5,
): Partes[] {
  const regexNomePessoa = /\b[A-ZÁ-Ú]{2,}(?:\s+[A-ZÁ-Ú]{2,})+\b/g;
  const regexEmpresa =
    /\b(?!CNPJ|CPF|SALA|ED|NNN|NNNN|NN)[A-ZÁ-Ú&.\-]{2,}(?:\s+[A-ZÁ-Ú&.\-]{2,})*(?:\s*(?:S\/?A|LTDA|ME|EIRELI))?\b/g;

  const gerarIniciais = (nome?: string): string => {
    if (!nome) return '';
    return nome
      .replace(/[.,]/g, '')
      .replace(/\b(S\/A|LTDA|ME|EIRELI)\b/g, '')
      ?.split(/\s+/)
      .map((w) => w[0])
      .join('');
  };

  // 🔹 Extrair nomes dos títulos
  const nomesExtraidos: string[] = [];
  const empresasExtraidas: string[] = [];

  titulos.forEach((item) => {
    const titulo = item.titulo || '';
    nomesExtraidos.push(...(titulo.match(regexNomePessoa) || []));
    empresasExtraidas.push(...(titulo.match(regexEmpresa) || []));
  });

  // 🔹 Limpar ruídos
  const limpar = (arr: string[]) =>
    arr.filter(
      (n) =>
        n.length > 3 &&
        !/^(CNPJ|CPF|NN\.|NNNN|SALA|ED)$/i.test(n.trim()) &&
        !/^\d+$/.test(n.trim()),
    );

  const nomesLimpados = limpar(nomesExtraidos);
  const empresasLimpadas = empresasExtraidas.filter((n) =>
    /\bS[\s./]*A\b|\bLTDA\b|\bME\b|\bEIRELI\b/.test(n),
  ); // 👈 garante que são empresas de verdade

  console.log('nomesLimpados', nomesLimpados);
  console.log('empresasLimpadas', empresasLimpadas);

  const todosNomesExtraidos = [...nomesLimpados, ...empresasLimpadas];

  return partes.map((parte) => {
    const copiaParte = { ...parte };

    // 👇 se for empresa, restringe à lista de empresas reais
    const nomesParaAssociar =
      parte.documento?.tipo === 'CNPJ'
        ? empresasLimpadas.length > 0
          ? empresasLimpadas
          : todosNomesExtraidos
        : todosNomesExtraidos;

    let melhorScore = 0;
    let melhorNome = copiaParte.nome;

    for (const nomeCompleto of nomesParaAssociar) {
      if (
        parte.documento?.numero &&
        nomeCompleto.includes(parte.documento.numero)
      ) {
        melhorNome = nomeCompleto;
        break;
      }

      // ⚖️ Impedir que ADVOGADO seja confundido com empresa
      if (parte.tipo === 'ADVOGADO' && nomeCompleto.match(regexEmpresa)) {
        continue;
      }

      const iniciaisParte = gerarIniciais(copiaParte.nome).toUpperCase();
      const iniciaisTitulo = gerarIniciais(nomeCompleto).toUpperCase();
      const score = scoreIniciais(iniciaisParte, iniciaisTitulo);

      if (
        score > melhorScore &&
        score >= limiar &&
        nomeCompleto?.split(' ').length > 1
      ) {
        melhorScore = score;
        melhorNome = nomeCompleto;
      }
    }

    // 🟢 Se é empresa (CNPJ) e há apenas uma empresa extraída, assume diretamente
    if (parte.documento?.tipo === 'CNPJ' && empresasLimpadas.length === 1) {
      melhorNome = empresasLimpadas[0];
    }

    copiaParte.nome = melhorNome;
    return copiaParte;
  });
}
