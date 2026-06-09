// src/guards/api-key.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';
// Limite defensivo para evitar alocações grandes em headers maliciosos (DoS).
const MAX_API_KEY_BYTES = 1024;

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  private readonly apiKey = process.env.API_KEY;

  canActivate(context: ExecutionContext): boolean {
    if (!this.apiKey) {
      throw new UnauthorizedException('API_KEY não configurada no servidor');
    }

    const request = context.switchToHttp().getRequest<Request>();

    const authHeader = request.headers['authorization'];
    if (
      typeof authHeader !== 'string' ||
      !authHeader.startsWith('Bearer ') ||
      !this.safeEquals(authHeader.slice('Bearer '.length), this.apiKey)
    ) {
      throw new UnauthorizedException('API key inválida ou ausente');
    }

    return true;
  }

  private safeEquals(left: string, right: string): boolean {
    // Rejeita headers excessivamente grandes antes de qualquer alocação.
    if (left.length > MAX_API_KEY_BYTES || right.length > MAX_API_KEY_BYTES) {
      return false;
    }

    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    const maxLen = Math.max(leftBuffer.length, rightBuffer.length);
    const paddedLeft = Buffer.alloc(maxLen);
    const paddedRight = Buffer.alloc(maxLen);
    leftBuffer.copy(paddedLeft);
    rightBuffer.copy(paddedRight);
    // timingSafeEqual exige buffers do mesmo tamanho; a checagem de comprimento
    // original é feita depois para não vazar informação por timing.
    return (
      timingSafeEqual(paddedLeft, paddedRight) &&
      leftBuffer.length === rightBuffer.length
    );
  }
}
