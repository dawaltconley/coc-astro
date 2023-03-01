set relativenumber

source ~/.vim/coc.vim

call coc#config('tsserver.enable', v:true)
call coc#config('eslint.enable', v:true)

" Use K to show documentation in preview window.
nnoremap <silent> K :call <SID>show_documentation()<CR>

function! s:show_documentation()
  if CocAction('hasProvider', 'hover')
    call CocActionAsync('doHover')
  else
    call feedkeys('K', 'in')
  endif
endfunction

" nnoremap <silent> gt :call CocActionAsync('jumpDeclaration')
