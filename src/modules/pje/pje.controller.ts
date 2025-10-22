import { Body, Controller, Param, Post, Query } from '@nestjs/common';
import { ConsultarProcessoQueue } from './queues/service/consultar-processo';
import { ConsultarProcessoDocumentoQueue } from './queues/service/consultar-processo-documento';
@Controller('processos')
export class PjeController {
  constructor(
    private readonly consultarProcessoQueue: ConsultarProcessoQueue,
    private readonly consultarProcessoDocumentoQueue: ConsultarProcessoDocumentoQueue,
  ) {}
  @Post('/:numero')
  async getFindProcess(
    @Param('numero') numero: string,
    @Body() body: { documents?: boolean; origem?: string; webhook?: string },
  ): Promise<any> {
    const { documents, origem, webhook } = body || {};
    return this.consultarProcessoQueue.execute(
      numero,
      origem,
      documents,
      webhook,
    );
  }
  // @Post('/:numero/documentos')
  // async getFindProcessDocuments(@Param('numero') numero: string): Promise<any> {
  //   return this.consultarProcessoDocumentoQueue.execute(numero);
  // }
}
