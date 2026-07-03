import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { Documento, ItensProcesso, ProcessosResponse } from 'src/interfaces';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { normalizeString } from 'src/utils/normalize-string';
import { regexDocumentos } from 'src/utils/regex-documents';
import { FetchDocumentoService } from './fetch-documents-url.service';

@Injectable()
export class ProcessDocumentsFindService {
  logger = new Logger(ProcessDocumentsFindService.name);

  constructor(
    private readonly awsS3Service: AwsS3Service,
    private readonly fetchDocumentoService: FetchDocumentoService,
  ) {}

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Erro desconhecido';
  }

  async execute(
    numeroDoProcesso: string,
    instances: ProcessosResponse[],
    regionTRT: number,
  ): Promise<ProcessosResponse[]> {
    try {
      const instancesWithGrau = instances.map((instance, i) => {
        const instanceNumber = i + 1;
        return {
          ...instance,
          grau: instanceNumber === 1 ? 'PRIMEIRO_GRAU' : 'SEGUNDO_GRAU',
          instance: instanceNumber.toString(),
        };
      });
      if (!instancesWithGrau || instancesWithGrau.length === 0) return [];

      const documentosRestritos = await this.fetchDocumentosRestritos(
        numeroDoProcesso,
        instances,
        regionTRT,
      );

      const newInstances = instancesWithGrau.map((instance) => ({
        ...instance,
        documentos: documentosRestritos,
      }));
      return newInstances;
    } catch (error: unknown) {
      const errorMessage = this.getErrorMessage(error);
      this.logger.error(`Error fetching restricted documents: ${errorMessage}`);
      throw new BadGatewayException(
        `Error fetching restricted documents: ${errorMessage}`,
      );
    }
  }

  private async fetchDocumentosRestritos(
    processNumber: string,
    instances: ProcessosResponse[],
    regionTRT: number,
  ): Promise<Documento[]> {
    const instanceEntries = instances
      .map((instance, i) => ({
        id: instance.id,
        instancia: (i + 1).toString(),
        itensProcesso: instance.itensProcesso ?? [],
      }))
      .filter((entry) => entry.itensProcesso.length > 0);

    if (instanceEntries.length === 0) {
      this.logger.warn(
        `⚠️ Nenhuma movimentação encontrada para ${processNumber}`,
      );
      return [];
    }

    // Busca os documentos relevantes de TODAS as instâncias (não só a
    // última), montando um contexto de headers/tokenCaptcha por instância.
    const perInstanceResults = await Promise.all(
      instanceEntries.map((entry) =>
        this.fetchDocumentosDaInstancia(
          processNumber,
          regionTRT,
          entry.id,
          entry.instancia,
          entry.itensProcesso,
        ),
      ),
    );

    const uploadedDocuments = perInstanceResults.flat();

    if (uploadedDocuments.length === 0) {
      this.logger.warn(
        `⚠️ Nenhum documento relevante encontrado para ${processNumber}`,
      );
    }

    return uploadedDocuments;
  }

  private async fetchDocumentosDaInstancia(
    processNumber: string,
    regionTRT: number,
    processId: number,
    instancia: string,
    itensProcesso: ItensProcesso[],
  ): Promise<Documento[]> {
    const itensRestritos = itensProcesso.filter(
      (item) =>
        item.documento &&
        regexDocumentos.some((r) => r.test(normalizeString(item.titulo))),
    );

    if (itensRestritos.length === 0) return [];

    const publicos = itensRestritos.filter((item) => item.publico).length;
    this.logger.log(
      `📊 Instância ${instancia} (${processNumber}): ${itensRestritos.length} documento(s) relevante(s) pra buscar (${publicos} público(s), ${itensRestritos.length - publicos} restrito(s))`,
    );

    // Monta headers/cookies/tokenCaptcha uma única vez por instância e busca
    // todos os documentos relevantes dela de uma só vez.
    const context = await this.fetchDocumentoService.buildContext(
      regionTRT,
      instancia,
      processNumber,
    );

    const results = await Promise.all(
      itensRestritos.map(async (item) => {
        try {
          const { buffer, contentType } =
            await this.fetchDocumentoService.fetchDocumento(
              context,
              processId,
              item.id,
              processNumber,
              item.titulo,
            );

          const extension = contentType.includes('pdf') ? 'pdf' : 'html';
          const fileKey = `${normalizeString(item.titulo)}_${item.id}_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 8)}.${extension}`;

          await this.awsS3Service.uploadS3Object(
            process.env.AWS_S3_BUCKET_NAME as string,
            fileKey,
            buffer,
            contentType,
          );

          const documento: Documento = {
            title: item.titulo,
            temp_link: fileKey,
            uniqueName: item.idUnicoDocumento,
            date: item.data,
          };
          return documento;
        } catch (error: unknown) {
          this.logger.error(
            `⚠️ Falha ao buscar documento "${item.titulo}" (id=${item.id}) para ${processNumber}: ${this.getErrorMessage(error)}`,
          );
          return null;
        }
      }),
    );

    const uploaded = results.filter(
      (documento): documento is Documento => documento !== null,
    );

    this.logger.log(
      `✅ Instância ${instancia} (${processNumber}): ${uploaded.length}/${itensRestritos.length} documento(s) baixado(s) com sucesso`,
    );

    return uploaded;
  }
}
