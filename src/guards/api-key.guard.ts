// src/guards/api-key.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import * as dotenv from 'dotenv';

dotenv.config();
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  private readonly apiKey = process.env.API_KEY;

  canActivate(context: ExecutionContext): boolean {
    if (!this.apiKey) {
      throw new UnauthorizedException('API_KEY não configurada no servidor');
    }

    const request = context.switchToHttp().getRequest<Request>();

    const authHeader = request.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${this.apiKey}`) {
      throw new UnauthorizedException('API key inválida ou ausente');
    }

    return true;
  }
}
