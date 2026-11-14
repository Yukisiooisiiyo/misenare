// 問い合わせフォームの送信。CSP で inline script を禁じているので、ここに置く。
(function () {
  var form = document.getElementById('contact-form');
  if (!form) return;
  var status = form.querySelector('.cstatus');
  var button = form.querySelector('button[type="submit"]');

  function say(text, ok) {
    status.textContent = text;
    status.className = 'cstatus ' + (ok ? 'ok' : 'ng');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = {
      name: form.elements.name.value.trim(),
      company: form.elements.company.value.trim(),
      email: form.elements.email.value.trim(),
      message: form.elements.message.value.trim(),
      website: form.elements.website.value,
    };
    if (!data.name || !data.email || !data.message) {
      say('お名前・メールアドレス・ご相談内容を入力してください。', false);
      return;
    }
    button.disabled = true;
    say('送信しています…', true);
    fetch('/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.ok) {
          form.reset();
          say('送信しました。内容を確認のうえ、ご連絡します。', true);
        } else if (res.status === 429) {
          say('送信が続いています。しばらく待ってから、もう一度お試しください。', false);
        } else {
          say(body.message || '送信できませんでした。時間をおいて、もう一度お試しください。', false);
        }
      });
    }).catch(function () {
      say('送信できませんでした。通信の状態を確かめて、もう一度お試しください。', false);
    }).then(function () { button.disabled = false; });
  });
})();
