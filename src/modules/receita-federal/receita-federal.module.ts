import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ReceitaFederalController } from './receita-federal.controller';
import { CnpjScraperService } from './services/find.service';
import { CndtScraperService } from './services/cndt-scraper.service';
import { CaptchaService } from 'src/services/captcha.service';
import { LambdaCaptchaService } from 'src/services/lambda-captcha.service';
import { ReCaptchaService } from './services/recaptcha.service';
import { AwsS3Service } from 'src/services/aws-s3.service';

@Module({
  imports: [HttpModule],
  controllers: [ReceitaFederalController],
  providers: [
    CnpjScraperService,
    CaptchaService,
    LambdaCaptchaService,
    CndtScraperService,
    ReCaptchaService,
    AwsS3Service,
  ],
})
export class ReceitaFederalModule {}
