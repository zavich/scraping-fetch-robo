import { Controller, Get, Response } from '@nestjs/common';
import { Response as ExpressResponse } from 'express';

@Controller()
export class AppController {
  @Get('health')
  health(@Response() res: ExpressResponse) {
    return res.status(200).json({
      status: 'ok',
    });
  }
}
