const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

async function sendOrderEmailToAdmin(orderNumber, total, address, items) {
  try {
    const addr = address || {};
    const itemRows = (items || []).map(i =>
      `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f0e0c0">${i.product?.name || 'Item'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0e0c0;text-align:center">${i.qty}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0e0c0;text-align:right">$${((i.variant?.price || i.product?.price || 0) * i.qty).toFixed(2)}</td>
      </tr>`
    ).join('');
    await transporter.sendMail({
      from: `"Houra Jewels" <${process.env.EMAIL_USER}>`,
      to: 'support@hourajewels.com',
      subject: `New Order Received - ${orderNumber}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;border:1px solid #f0e0c0;border-radius:12px">
          <h2 style="color:#08183A">🛍️ New Order — ${orderNumber}</h2>
          <p><strong>Total:</strong> $${total}</p>
          <h3 style="color:#b45309;margin-top:16px">Shipping Address</h3>
          <p style="margin:0">${addr.name || ''}</p>
          <p style="margin:0">${addr.line1 || ''}</p>
          <p style="margin:0">${[addr.city, addr.state, addr.pincode].filter(Boolean).join(', ')}</p>
          <p style="margin:0">${addr.country || ''}</p>
          <p style="margin:0">${addr.mobile || ''}</p>
          <h3 style="color:#b45309;margin-top:16px">Items</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:#fff7ed">
              <th style="padding:6px 8px;text-align:left">Product</th>
              <th style="padding:6px 8px">Qty</th>
              <th style="padding:6px 8px;text-align:right">Price</th>
            </tr></thead>
            <tbody>${itemRows}</tbody>
          </table>
          <p style="margin-top:16px;color:#6b7280;font-size:12px">Check the admin dashboard for full details.</p>
        </div>
      `
    });
  } catch (err) {
    console.error('Email send failed:', err);
  }
}

async function sendRefundEmail({ order, refundId, refundAmount, cancelType, cancelledItems, remainingItems, transactionCharge }) {
  try {
    let address = {};
    try { address = typeof order.address === 'string' ? JSON.parse(order.address) : (order.address || {}); } catch(e) {}
    const customerEmail = order.user_email;
    const orderNum = order.order_number || order.id;
    const isNoRefund = cancelType === 'no_refund' || cancelType === 'coupon_cancel';
    const isCoupon = cancelType === 'coupon_cancel';

    const cancelledRows = (cancelledItems || []).map(i =>
      `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f0e0c0">${i.name || 'Item'}${i.color ? ` — ${i.color}` : ''}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0e0c0;text-align:center">${i.size || '—'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0e0c0;text-align:center">${i.qty}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0e0c0;text-align:right">$${(i.price || 0).toFixed(2)}</td>
      </tr>`
    ).join('');

    const refundSection = isNoRefund
      ? `<p style="color:#b45309;font-weight:600">${isCoupon ? '🎟️ This order was cancelled with a discount coupon — no monetary refund issued.' : '⚠️ This cancellation was processed without a refund.'}</p>`
      : `<p><strong>Refund Amount:</strong> <span style="color:#059669;font-size:16px;font-weight:700">$${refundAmount.toFixed(2)}</span></p>
         ${transactionCharge > 0 ? `<p style="color:#6b7280;font-size:12px">Transaction/cancellation charge deducted: $${transactionCharge.toFixed(2)}</p>` : ''}
         <p style="color:#6b7280;font-size:12px">Refund ID: <code>${refundId}</code></p>
         <p style="color:#6b7280;font-size:12px">Refunds typically appear in 5–10 business days.</p>`;

    const remainingSection = remainingItems && remainingItems.length > 0
      ? `<p style="margin-top:12px"><strong>${remainingItems.length} item(s) remain active</strong> in your order and will be fulfilled as usual.</p>`
      : '';

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;border:1px solid #f0e0c0;border-radius:12px">
        <h2 style="color:#08183A">Order Cancellation — #${orderNum}</h2>
        <p>Hi ${address.name || order.user_name || 'Customer'},</p>
        <p>${cancelledItems && cancelledItems.length > 0 ? 'The following items have been cancelled from your order:' : 'Your order has been fully cancelled.'}</p>
        ${cancelledItems && cancelledItems.length > 0 ? `
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0">
          <thead><tr style="background:#fff7ed">
            <th style="padding:6px 8px;text-align:left">Product</th>
            <th style="padding:6px 8px">Size</th>
            <th style="padding:6px 8px">Qty</th>
            <th style="padding:6px 8px;text-align:right">Amount</th>
          </tr></thead>
          <tbody>${cancelledRows}</tbody>
        </table>` : ''}
        ${refundSection}
        ${remainingSection}
        <p style="margin-top:16px;color:#6b7280;font-size:12px">If you have questions, contact us at support@hourajewels.com</p>
      </div>`;

    const promises = [];
    // Email to customer
    if (customerEmail) {
      promises.push(transporter.sendMail({
        from: `"Houra Jewels" <${process.env.EMAIL_USER}>`,
        to: customerEmail,
        subject: `Order ${isNoRefund ? 'Cancelled' : 'Cancellation & Refund'} — #${orderNum}`,
        html,
      }));
    }
    // Email to admin
    promises.push(transporter.sendMail({
      from: `"Houra Jewels" <${process.env.EMAIL_USER}>`,
      to: 'support@hourajewels.com',
      subject: `[Admin] Order ${isNoRefund ? 'Cancelled (No Refund)' : 'Refund Issued'} — #${orderNum}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px">
        <h2 style="color:#08183A">${isNoRefund ? 'Order Cancelled (No Refund)' : 'Refund Issued'} — #${orderNum}</h2>
        <p><strong>Customer:</strong> ${address.name || order.user_name || '—'} (${customerEmail || '—'})</p>
        <p><strong>Cancel Type:</strong> ${cancelType}</p>
        ${!isNoRefund ? `<p><strong>Refund:</strong> $${refundAmount.toFixed(2)} | ID: <code>${refundId}</code></p>` : ''}
        ${html}
      </div>`,
    }));
    await Promise.allSettled(promises);
  } catch (err) {
    console.error('Refund email failed:', err);
  }
}

module.exports = { transporter, sendOrderEmailToAdmin, sendRefundEmail };
