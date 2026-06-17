// src/aws/aws-s3.service.ts
import { Injectable } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
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
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType || 'application/octet-stream',
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async getS3Object(bucket: string, key: string): Promise<Buffer> {
    const response = await this.s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!response.Body) {
      throw new Error(
        `S3 object body is empty or missing for key: ${key} in bucket: ${bucket}`,
      );
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async deleteS3Object(bucket: string, key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  }
}
