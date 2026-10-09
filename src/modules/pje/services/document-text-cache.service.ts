import { Injectable, Logger } from '@nestjs/common';
import { AwsS3Service } from 'src/services/aws-s3.service';

const PREFIXO = 'cache-texto-documentos';

// Cache do texto já extraído de documentos PÚBLICOS, para a recoleta de um
// processo não baixar do PJe e passar pela Lambda de novo o que já extraiu.
// Documento juntado aos autos não muda de conteúdo — um novo vira outro item,
// com outro id —, então o texto vale para sempre e não há invalidação.
//
// S3 e não Redis: o Redis já sofreu OOM com a carga das filas, e o volume
// aqui cresce com cada documento coletado.
//
// A chave inclui processo e `id` além do `idUnicoDocumento`: este é um hash
// curto (7 caracteres), sem garantia de unicidade entre processos.
//
// Falha do cache nunca derruba a coleta: leitura com erro é tratada como miss
// e gravação com erro só é logada.
@Injectable()
export class DocumentTextCacheService {
  private readonly logger = new Logger(DocumentTextCacheService.name);
  private readonly bucket = process.env.AWS_S3_BUCKET_NAME;

  constructor(private readonly awsS3Service: AwsS3Service) {}

  private chave(
    typeUrl: string,
    processNumber: string,
    id: number | string,
    idUnicoDocumento: string,
  ): string {
    return `${PREFIXO}/${typeUrl}/${processNumber}/${id}-${idUnicoDocumento}.txt`;
  }

  async get(
    typeUrl: string,
    processNumber: string,
    id: number | string,
    idUnicoDocumento: string,
  ): Promise<string | null> {
    if (!this.bucket) return null;
    const key = this.chave(typeUrl, processNumber, id, idUnicoDocumento);
    try {
      const buffer = await this.awsS3Service.getS3Object(this.bucket, key);
      return buffer.toString('utf8');
    } catch (err) {
      const nome = err instanceof Error ? err.name : '';
      if (nome !== 'NoSuchKey') {
        this.logger.warn(
          `Falha ao ler cache de texto ${key} — seguindo sem cache: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return null;
    }
  }

  async set(
    typeUrl: string,
    processNumber: string,
    id: number | string,
    idUnicoDocumento: string,
    texto: string,
  ): Promise<void> {
    if (!this.bucket) return;
    const key = this.chave(typeUrl, processNumber, id, idUnicoDocumento);
    try {
      await this.awsS3Service.uploadS3Object(
        this.bucket,
        key,
        texto,
        'text/plain; charset=utf-8',
      );
    } catch (err) {
      this.logger.warn(
        `Falha ao gravar cache de texto ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
