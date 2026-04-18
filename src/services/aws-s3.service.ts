// src/aws/aws-s3.service.ts
import { Injectable } from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

@Injectable()
export class AwsS3Service {
  private s3: S3Client;
  private bucket = process.env.AWS_S3_BUCKET_NAME;

  constructor() {
    this.s3 = new S3Client({
      region: process.env.AWS_S3_REGION as string,
    });
  }

  async uploadPdf(buffer: Buffer, fileName?: string): Promise<string> {
    const key = fileName || `${randomUUID()}.pdf`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/pdf',
      }),
    );

    return `https://${this.bucket}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${key}`;
  }

  async uploadS3Object(
    bucket: string,
    key: string,
    body: Buffer | Uint8Array | string,
    contentType?: string,
  ): Promise<void> {
    const s3Client = this.s3;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType || 'application/octet-stream',
        ServerSideEncryption: 'AES256',
      }),
    );
  }
}
