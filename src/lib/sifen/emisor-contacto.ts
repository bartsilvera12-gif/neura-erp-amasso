/**
 * Datos de contacto del emisor que van en el XML de SIFEN (`dTelEmi` / `dEmailE`).
 *
 * Viven en un solo lugar a propósito: estaban repetidos en la factura y en la
 * nota de crédito, y al corregir el teléfono había que acordarse de tocar los
 * dos archivos. Si se desincronizan, SIFEN recibe un dato distinto según el
 * tipo de documento.
 *
 * PENDIENTE — los dos valores de abajo son los placeholders que venían del ERP
 * de origen, NO los de Amasso. SIFEN los rechaza o los publica mal en el KUDE:
 * hay que poner el teléfono y el correo reales del contribuyente antes de
 * facturar en producción. `dTelEmi` admite entre 8 y 15 dígitos
 * (ver `rde-xml.ts`).
 */
export const SIFEN_EMISOR_TELEFONO = "021000000";
export const SIFEN_EMISOR_EMAIL = "facturacion@configurar-empresa.com.py";
